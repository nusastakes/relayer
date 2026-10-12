// The relayer's logic, separate from HTTP so it can be tested with fake clients.
//
// What it does: pays the gas for a resident's deposit (CityVault.depositWithPermit) and, on testnet, requests free
// AUSD from the public faucet for a new resident. It never holds user funds: the vault mints shares to `owner`, the
// signer of the permit, whoever submits the transaction.

import { parseAbi, parseEventLogs } from "viem";
import { HttpError, Mutex, createRateLimiter, parseDepositBody, parseFaucetBody, parseWithdrawBody } from "./guards.mjs";

export const vaultAbi = parseAbi([
  "function depositWithPermit(address owner, uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 shares)",
  "function redeemWithPermit(address owner, uint256 shares, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 assets)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
]);
export const factoryAbi = parseAbi(["function isCity(address) view returns (bool)"]);
export const faucetAbi = parseAbi(["function requestFunds(address recipient)"]);

const shortReason = (e) => (e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 200);
/** Every place a revert reason can hide: message, details, and raw revert data. */
const fullReason = (e) => [e?.shortMessage, e?.message, e?.details, e?.data, e?.cause?.data, e?.cause?.message].filter(Boolean).join(" ");
/** The faucet's `MaxFrequencyExceeded()` error, which is not in our ABI so viem cannot name it. */
export const FAUCET_FREQUENCY_ERROR = /MaxFrequencyExceeded|0x20e5bc67/;

export function createRelayer({ publicClient, walletClient, config, style = null, analyst = null, book = null, indexer = null, humas = null, economy = null, now = () => Date.now() }) {
  const c = {
    factory: config.factory,
    faucet: config.faucet,
    maxAssets: config.maxAssets ?? 10_000n * 1_000_000n,
    minDeadlineSeconds: config.minDeadlineSeconds ?? 20,
    minBalance: config.minBalance ?? 10n ** 17n, // 0.1 MON
    gasMultiplierPercent: config.gasMultiplierPercent ?? 125n,
    maxGas: config.maxGas ?? 1_500_000n,
    gasDripWei: config.gasDripWei ?? 10n ** 18n, // 1 MON: founding a city needs about 0.63 MON in the wallet at a tight fee cap
    gasDripBelowWei: config.gasDripBelowWei ?? 7n * 10n ** 17n, // only to wallets holding less than 0.7 MON
    // Spend controls. The per-IP limits stop one client; these stop everybody together from emptying the wallet.
    dripFloorWei: config.dripFloorWei ?? 2n * 10n ** 18n, // drips pause when they would leave less than this for sponsored deposits
    gasDripsPerDay: config.gasDripsPerDay ?? 40,
    maxQueue: config.maxQueue ?? 10, // transactions running or waiting; more are refused instead of piling up
    dailyGasCapWei: config.dailyGasCapWei ?? 5n * 10n ** 18n, // upper bound of gas the relayer will commit to sponsored transactions per day
    lowFundsWei: config.lowFundsWei ?? 2n * 10n ** 18n, // /health reports lowFunds below this
  };
  const account = walletClient.account;
  const mutex = new Mutex();
  const perOwner = createRateLimiter({ windowMs: 60_000, max: 3, now });
  const perOwnerWithdraw = createRateLimiter({ windowMs: 60_000, max: 3, now });
  const perFaucetAddress = createRateLimiter({ windowMs: 10 * 60_000, max: 1, now });
  const perDripAddress = createRateLimiter({ windowMs: 24 * 3_600_000, max: 1, now });
  const dripGlobal = createRateLimiter({ windowMs: 3_600_000, max: config.gasDripsPerHour ?? 10, now });
  const dripDaily = createRateLimiter({ windowMs: 24 * 3_600_000, max: c.gasDripsPerDay, now });
  const global = createRateLimiter({ windowMs: 60_000, max: config.globalPerMinute ?? 30, now });
  // Per client IP (only when the HTTP layer knows it). A public relayer cannot rely on per-address limits alone,
  // because anybody can make fresh addresses for free.
  const ipLimits = {
    deposit: createRateLimiter({ windowMs: 60_000, max: 30, now }),
    withdraw: createRateLimiter({ windowMs: 60_000, max: 30, now }),
    faucet: createRateLimiter({ windowMs: 3_600_000, max: 5, now }),
    // Counts every faucet call, including those the faucet's own cooldown refuses (which refund the limit above), so
    // polling the endpoint is not free.
    faucetAttempts: createRateLimiter({ windowMs: 3_600_000, max: 60, now }),
    gasDrip: createRateLimiter({ windowMs: 24 * 3_600_000, max: 3, now }),
  };
  function guardIp(kind, ip, spent = []) {
    if (!ip) return;
    if (!ipLimits[kind].hit(ip)) {
      throw new HttpError(429, `too many ${kind === "faucetAttempts" ? "faucet" : kind} requests from this address`, { retryAfterSeconds: Math.ceil(ipLimits[kind].retryAfterMs(ip) / 1000) });
    }
    spent.push(() => ipLimits[kind].refund(ip));
  }

  function guardRate(limiter, key, label, spent = []) {
    if (!global.hit("all")) throw new HttpError(429, "relayer is busy, try again shortly", { retryAfterSeconds: 10 });
    spent.push(() => global.refund("all"));
    if (!limiter.hit(key)) {
      spent.pop()();
      throw new HttpError(429, `too many ${label} requests`, { retryAfterSeconds: Math.ceil(limiter.retryAfterMs(key) / 1000) });
    }
    spent.push(() => limiter.refund(key));
  }

  /**
   * Limits exist to bound requests that cost gas. A request that fails before sending anything (bad signature, the
   * faucet's own cooldown) must not use up the caller's allowance, or a client retrying politely gets locked out.
   */
  async function refundingOnFailure(spent, work) {
    try {
      return await work();
    } catch (e) {
      for (const give of spent) give();
      throw e;
    }
  }

  /** Gas committed to sponsored transactions in the last 24 hours, as an upper bound (gas limit x max fee). */
  const spendLog = [];
  function spentLast24h() {
    const cutoff = now() - 86_400_000;
    while (spendLog.length && spendLog[0].at < cutoff) spendLog.shift();
    return spendLog.reduce((sum, entry) => sum + entry.wei, 0n);
  }
  /** Reserves part of the daily budget; the returned function gives it back if the transaction was never sent. */
  function reserveSpend(wei) {
    if (spentLast24h() + wei > c.dailyGasCapWei) throw new HttpError(503, "the relayer's daily gas budget is used up, try again later", { retryAfterSeconds: 3600 });
    const entry = { at: now(), wei };
    spendLog.push(entry);
    return () => {
      const i = spendLog.indexOf(entry);
      if (i >= 0) spendLog.splice(i, 1);
    };
  }
  function requireQueueRoom() {
    if (mutex.depth >= c.maxQueue) throw new HttpError(503, "the relayer has too many transactions waiting, try again shortly", { retryAfterSeconds: 5 });
  }

  async function requireFunds(needed = 0n) {
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < c.minBalance || balance < needed) throw new HttpError(503, "relayer is out of gas funds");
  }

  /**
   * Monad rejects a transaction unless balance >= gasLimit x maxFeePerGas (and then charges gasLimit x the effective
   * price), so a tight maxFeePerGas matters: 1.5x the current base fee plus the tip instead of viem's 2x default.
   */
  async function feeCaps() {
    const block = await publicClient.getBlock();
    if (block.baseFeePerGas === undefined || block.baseFeePerGas === null) return {};
    const tip = publicClient.estimateMaxPriorityFeePerGas ? await publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n) : 0n;
    return { maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + tip, maxPriorityFeePerGas: tip };
  }

  async function send(request) {
    let gas;
    try {
      gas = await publicClient.estimateContractGas({ ...request, account });
    } catch (e) {
      throw new HttpError(400, `transaction would fail: ${shortReason(e)}`);
    }
    // Monad charges the gas limit, not the gas used, so keep it close to the estimate.
    gas = (gas * c.gasMultiplierPercent) / 100n;
    if (gas > c.maxGas) gas = c.maxGas;
    const fees = await feeCaps();
    if (fees.maxFeePerGas) await requireFunds(gas * fees.maxFeePerGas);
    requireQueueRoom();
    const release = reserveSpend(gas * (fees.maxFeePerGas ?? 0n));
    return mutex.run(async () => {
      let hash;
      try {
        hash = await walletClient.writeContract({ ...request, gas, ...fees });
      } catch (e) {
        release(); // nothing was sent
        throw e;
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, receipt };
    });
  }

  return {
    config: c,
    /** The optional city-style store (src/style.mjs); the HTTP layer serves /style from it. */
    style,
    /** The optional Analyst bot (src/analyst.mjs): /analyst, /proposals/:city and the scan loop. */
    analyst,
    /** The optional untrusted ciphertext store for the sealed strategy book (src/book.mjs). */
    book,
    /** Optional on-chain indexer (leaderboard, metrics), the Humas report writer and the economy aggregator. */
    indexer,
    humas,
    economy,

    async health() {
      const [balance, head, analystBalance] = await Promise.all([
        publicClient.getBalance({ address: account.address }),
        publicClient.getBlock(),
        analyst ? analyst.balance() : Promise.resolve(null),
      ]);
      return {
        ok: true,
        relayer: account.address,
        balanceWei: balance.toString(),
        // True when the relayer (or the Analyst) is nearly out of MON and needs a top-up before the demo.
        lowFunds: balance < c.lowFundsWei || (analystBalance !== null && analystBalance < c.lowFundsWei / 4n),
        ...(analystBalance !== null ? { analystBalanceWei: analystBalance.toString() } : {}),
        queueDepth: mutex.depth,
        gasSpentLast24hWei: spentLast24h().toString(),
        block: head.number.toString(),
        factory: c.factory,
        faucetEnabled: Boolean(c.faucet),
        gasDripEnabled: c.gasDripWei > 0n,
        styleEnabled: Boolean(style),
        analystEnabled: Boolean(analyst),
        bookEnabled: Boolean(book),
        indexerEnabled: Boolean(indexer),
        humasEnabled: Boolean(humas),
        economyEnabled: Boolean(economy),
      };
    },

    /** POST /deposit */
    async deposit(rawBody, ctx = {}) {
      guardIp("deposit", ctx.ip);
      const b = parseDepositBody(rawBody);
      const nowSeconds = BigInt(Math.floor(now() / 1000));
      if (b.deadline < nowSeconds + BigInt(c.minDeadlineSeconds)) throw new HttpError(400, "permit deadline is too close or already passed");
      if (b.assets > c.maxAssets) throw new HttpError(400, `assets above the relayer limit of ${c.maxAssets}`);
      const spent = [];
      guardRate(perOwner, b.owner.toLowerCase(), "deposit", spent);

      return refundingOnFailure(spent, async () => {
        const isCity = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "isCity", args: [b.vault] });
        if (!isCity) throw new HttpError(400, "vault was not created by the city factory");
        const room = await publicClient.readContract({ address: b.vault, abi: vaultAbi, functionName: "maxDeposit", args: [b.owner] });
        if (b.assets > room) throw new HttpError(400, `city only has room for ${room} more`);
        await requireFunds();

        const { hash, receipt } = await send({
          address: b.vault,
          abi: vaultAbi,
          functionName: "depositWithPermit",
          args: [b.owner, b.assets, b.deadline, b.v, b.r, b.s],
        });
        const [deposit] = parseEventLogs({ abi: vaultAbi, eventName: "Deposit", logs: receipt.logs });
        return {
          hash,
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          shares: deposit ? deposit.args.shares.toString() : null,
          sharesOwner: deposit ? deposit.args.owner : null,
        };
      });
    },

    /** POST /withdraw: redeem the owner's shares with a signed share permit; the assets go to the owner. */
    async withdraw(rawBody, ctx = {}) {
      guardIp("withdraw", ctx.ip);
      const b = parseWithdrawBody(rawBody);
      const nowSeconds = BigInt(Math.floor(now() / 1000));
      if (b.deadline < nowSeconds + BigInt(c.minDeadlineSeconds)) throw new HttpError(400, "permit deadline is too close or already passed");
      const spent = [];
      guardRate(perOwnerWithdraw, b.owner.toLowerCase(), "withdraw", spent);

      return refundingOnFailure(spent, async () => {
        const isCity = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "isCity", args: [b.vault] });
        if (!isCity) throw new HttpError(400, "vault was not created by the city factory");
        const held = await publicClient.readContract({ address: b.vault, abi: vaultAbi, functionName: "maxRedeem", args: [b.owner] });
        if (b.shares > held) throw new HttpError(400, `owner only holds ${held} shares`);
        await requireFunds();

        const { hash, receipt } = await send({
          address: b.vault,
          abi: vaultAbi,
          functionName: "redeemWithPermit",
          args: [b.owner, b.shares, b.deadline, b.v, b.r, b.s],
        });
        const [withdrawal] = parseEventLogs({ abi: vaultAbi, eventName: "Withdraw", logs: receipt.logs });
        return {
          hash,
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          assets: withdrawal ? withdrawal.args.assets.toString() : null,
          receiver: withdrawal ? withdrawal.args.receiver : null,
        };
      });
    },

    /**
     * POST /gas-drip (testnet only): a small amount of MON for a wallet that has to send its own transactions, for
     * example a mayor founding a city or a session key rebalancing. Once per address per day, only to wallets that
     * hold less than `gasDripBelowWei`, and capped per hour overall.
     */
    async gasDrip(rawBody, ctx = {}) {
      guardIp("gasDrip", ctx.ip);
      const b = parseFaucetBody(rawBody);
      if (b.address.toLowerCase() === account.address.toLowerCase()) throw new HttpError(400, "that is the relayer itself");
      const held = await publicClient.getBalance({ address: b.address });
      if (held >= c.gasDripBelowWei) throw new HttpError(400, `address already holds ${held} wei, no drip needed`);
      if (!dripGlobal.hit("all")) throw new HttpError(429, "gas drips are used up for this hour", { retryAfterSeconds: Math.ceil(dripGlobal.retryAfterMs("all") / 1000) });
      const spent = [() => dripGlobal.refund("all")];
      if (!dripDaily.hit("all")) {
        spent[0]();
        throw new HttpError(429, "gas drips are used up for today", { retryAfterSeconds: Math.ceil(dripDaily.retryAfterMs("all") / 1000) });
      }
      spent.push(() => dripDaily.refund("all"));
      try {
        guardRate(perDripAddress, b.address.toLowerCase(), "gas-drip", spent);
      } catch (e) {
        for (const give of spent) give();
        throw e;
      }
      return refundingOnFailure(spent, async () => {
        const fees = await feeCaps();
        const cost = c.gasDripWei + 21_000n * (fees.maxFeePerGas ?? 0n);
        // Keep a reserve for sponsored deposits and withdrawals: drips are a convenience, those are the product.
        const balance = await publicClient.getBalance({ address: account.address });
        if (balance < cost + c.dripFloorWei) throw new HttpError(503, "gas drips are paused to keep the relayer funded for deposits", { retryAfterSeconds: 600 });
        requireQueueRoom();
        await requireFunds(cost);
        const hash = await mutex.run(async () => {
          const h = await walletClient.sendTransaction({ to: b.address, value: c.gasDripWei, gas: 21_000n, ...fees });
          await publicClient.waitForTransactionReceipt({ hash: h });
          return h;
        });
        return { hash, recipient: b.address, amountWei: c.gasDripWei.toString() };
      });
    },

    /** POST /faucet (testnet only): free AUSD for a new resident, gas paid by the relayer. */
    async faucet(rawBody, ctx = {}) {
      guardIp("faucetAttempts", ctx.ip);
      const spentIp = [];
      guardIp("faucet", ctx.ip, spentIp);
      const b = parseFaucetBody(rawBody);
      if (!c.faucet) throw new HttpError(404, "faucet is not configured");
      const spent = [];
      guardRate(perFaucetAddress, b.address.toLowerCase(), "faucet", spent);
      try {
        return await refundingOnFailure(spent, async () => {
          await requireFunds();
          const request = { address: c.faucet, abi: faucetAbi, functionName: "requestFunds", args: [b.address] };
          try {
            await publicClient.simulateContract({ ...request, account });
          } catch (e) {
            if (FAUCET_FREQUENCY_ERROR.test(fullReason(e))) {
              throw new HttpError(429, "the faucet was used a moment ago, try again", { retryAfterSeconds: 20, faucetCooldown: true });
            }
            throw new HttpError(400, `faucet would refuse: ${shortReason(e)}`);
          }
          const { hash, receipt } = await send(request);
          return { hash, status: receipt.status, recipient: b.address };
        });
      } catch (e) {
        // The faucet's own cooldown costs nothing and is nobody's fault, so it should not count against the IP either.
        if (e?.extra?.faucetCooldown) for (const give of spentIp) give();
        throw e;
      }
    },
  };
}
