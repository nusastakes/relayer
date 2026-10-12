// The relayer's logic, separate from HTTP so it can be tested with fake clients.
//
// What it does: pays the gas for a resident's deposit (CityVault.depositWithPermit) and, on testnet, requests free
// AUSD from the public faucet for a new resident. It never holds user funds: the vault mints shares to `owner`, the
// signer of the permit, whoever submits the transaction.

import { parseAbi, parseEventLogs } from "viem";
import { HttpError, Mutex, createRateLimiter, parseDepositBody, parseFaucetBody } from "./guards.mjs";

export const vaultAbi = parseAbi([
  "function depositWithPermit(address owner, uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 shares)",
  "function maxDeposit(address) view returns (uint256)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
]);
export const factoryAbi = parseAbi(["function isCity(address) view returns (bool)"]);
export const faucetAbi = parseAbi(["function requestFunds(address recipient)"]);

const shortReason = (e) => (e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 200);

export function createRelayer({ publicClient, walletClient, config, now = () => Date.now() }) {
  const c = {
    factory: config.factory,
    faucet: config.faucet,
    maxAssets: config.maxAssets ?? 10_000n * 1_000_000n,
    minDeadlineSeconds: config.minDeadlineSeconds ?? 20,
    minBalance: config.minBalance ?? 10n ** 17n, // 0.1 MON
    gasMultiplierPercent: config.gasMultiplierPercent ?? 125n,
    maxGas: config.maxGas ?? 1_500_000n,
  };
  const account = walletClient.account;
  const mutex = new Mutex();
  const perOwner = createRateLimiter({ windowMs: 60_000, max: 3, now });
  const perFaucetAddress = createRateLimiter({ windowMs: 10 * 60_000, max: 1, now });
  const global = createRateLimiter({ windowMs: 60_000, max: config.globalPerMinute ?? 30, now });

  function guardRate(limiter, key, label) {
    if (!global.hit("all")) throw new HttpError(429, "relayer is busy, try again shortly", { retryAfterSeconds: 10 });
    if (!limiter.hit(key)) {
      throw new HttpError(429, `too many ${label} requests`, { retryAfterSeconds: Math.ceil(limiter.retryAfterMs(key) / 1000) });
    }
  }

  async function requireFunds() {
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < c.minBalance) throw new HttpError(503, "relayer is out of gas funds");
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
    return mutex.run(async () => {
      const hash = await walletClient.writeContract({ ...request, gas });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { hash, receipt };
    });
  }

  return {
    config: c,

    async health() {
      const [balance, head] = await Promise.all([publicClient.getBalance({ address: account.address }), publicClient.getBlock()]);
      return { ok: true, relayer: account.address, balanceWei: balance.toString(), block: head.number.toString(), factory: c.factory };
    },

    /** POST /deposit */
    async deposit(rawBody) {
      const b = parseDepositBody(rawBody);
      const nowSeconds = BigInt(Math.floor(now() / 1000));
      if (b.deadline < nowSeconds + BigInt(c.minDeadlineSeconds)) throw new HttpError(400, "permit deadline is too close or already passed");
      if (b.assets > c.maxAssets) throw new HttpError(400, `assets above the relayer limit of ${c.maxAssets}`);
      guardRate(perOwner, b.owner.toLowerCase(), "deposit");

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
    },

    /** POST /faucet (testnet only): free AUSD for a new resident, gas paid by the relayer. */
    async faucet(rawBody) {
      const b = parseFaucetBody(rawBody);
      if (!c.faucet) throw new HttpError(404, "faucet is not configured");
      guardRate(perFaucetAddress, b.address.toLowerCase(), "faucet");
      await requireFunds();
      const request = { address: c.faucet, abi: faucetAbi, functionName: "requestFunds", args: [b.address] };
      try {
        await publicClient.simulateContract({ ...request, account });
      } catch (e) {
        const reason = shortReason(e);
        if (/MaxFrequencyExceeded/.test(reason)) throw new HttpError(429, "the faucet was used a moment ago, try again", { retryAfterSeconds: 20 });
        throw new HttpError(400, `faucet would refuse: ${reason}`);
      }
      const { hash, receipt } = await send(request);
      return { hash, status: receipt.status, recipient: b.address };
    },
  };
}
