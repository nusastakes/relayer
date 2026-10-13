// A small on-chain indexer for the relayer (PRD R12 leaderboard, backlog BT.4 metrics, and the Humas report).
//
// Monad's public RPC limits eth_getLogs to 100 blocks per request, so the indexer walks the chain in chunks from the
// factory's deploy block, remembers how far it got, and keeps only what the product needs:
//   * which cities exist (factory CityCreated) and who their mayors are;
//   * each city's holders, from share Transfer events, so "residents" can be counted;
//   * a short ledger of deposits, withdrawals, rebalances, evacuations, fee mints and key reveals (with timestamps);
//   * hourly snapshots of each city's share price and total assets, so a report can say how a week went;
//   * optionally (when their addresses are configured) staff hires paid through the AgentMarketplace and granted by the
//     CityGuardian, and every event of the CityServices contract (launchpad, prediction markets, streamed fees), so
//     GET /history/:city can measure the city's traffic: what outside users did with the services the mayor provides.
// TVL and return since founding are always read live from the chain; the index adds what live reads cannot give.
// It is a convenience, not a source of truth: everything it stores can be rebuilt from the chain.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, parseAbi, parseEventLogs } from "viem";
import { KIND_NAMES, servicesAbi } from "./services.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const PRICE_SCALE = 10n ** 18n;
const LEDGER_CAP = 1000;
const SNAPSHOT_CAP = 24 * 14;
const TOKENS_CAP = 100;
const HISTORY_EVENTS_CAP = 500;
/** A city is ranked on the leaderboard from 1 AUSD (6 decimals) of assets. */
const MIN_RANKED_TVL = 1_000_000n;

export const indexAbi = [
  ...parseAbi([
    "event CityCreated(address indexed vault, address indexed mayor, string name, string community, uint16 feeBps, string mapURI)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
    "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
    "event Rebalanced(address indexed caller, address indexed from, address indexed to, uint256 amount, bytes32 planHash)",
    "event Evacuated(address indexed adapter, uint256 amount)",
    "event FeeAccrued(uint256 feeShares, uint256 platformShares, uint256 mayorShares, uint256 newHighWaterMark)",
    "event PlanKeyRevealed(bytes32 indexed entryId, bytes32 key)",
    // CityGuardian and AgentMarketplace: a paid hire is a Hired followed by an AgentGranted in the same transaction.
    "event AgentGranted(address indexed city, address indexed agent, uint8 role, uint64 expiry)",
    "event Hired(uint256 indexed listingId, uint256 indexed agentId, address indexed client, address agentWallet, bytes32 capability, uint64 until, uint256 paidToAgent, uint256 fee)",
  ]),
  ...servicesAbi.filter((x) => x.type === "event"),
];
const factoryAbi = parseAbi([
  "function platformTreasury() view returns (address)",
  "function cityCount() view returns (uint256)",
  "function cityInfos(uint256 start, uint256 count) view returns ((address vault, address mayor, string name, string community, string mapURI, uint16 feeBps, uint64 createdAt, uint256 totalAssets, uint256 totalSupply, uint256 pricePerShare, address[] adapters)[])",
]);

const lower = (a) => a.toLowerCase();

export function createIndexer({ publicClient, logsClient = publicClient, config, file, now = () => Date.now() }) {
  // `logsClient` serves getLogs only, so a provider with a wider block range (for example Envio HyperRPC) can be plugged in
  // without moving the other reads.
  const c = {
    factory: config.factory,
    startBlock: BigInt(config.startBlock),
    range: BigInt(config.range ?? 100),
    maxRequestsPerStep: config.maxRequestsPerStep ?? 80,
    snapshotIntervalSeconds: config.snapshotIntervalSeconds ?? 3600,
    // Contracts besides the factory and the vaults: CityGuardian and AgentMarketplace (hires) and CityServices.
    extras: [
      config.guardian && { address: getAddress(config.guardian), role: "guardian", fromBlock: BigInt(config.startBlock) },
      config.market && { address: getAddress(config.market), role: "market", fromBlock: BigInt(config.startBlock) },
      config.services && { address: getAddress(config.services), role: "services", fromBlock: BigInt(config.servicesFromBlock ?? config.startBlock) },
    ].filter(Boolean),
  };
  const roles = new Map(c.extras.map((x) => [lower(x.address), x.role]));
  /** @type {{nextBlock: string, treasury: string | null, cities: Record<string, any>, snapshots: Record<string, {ts: number, pps: string, tvl: string}[]>, lastSnapshotAt: number, extras: Record<string, boolean>, backfill: {addresses: string[], next: string, to: string}[], markets: Record<string, any>}} */
  let state = { nextBlock: c.startBlock.toString(), treasury: null, cities: {}, snapshots: {}, lastSnapshotAt: 0, extras: {}, backfill: [], markets: {} };
  let head = 0n;
  const blockTime = new Map();

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved && typeof saved.nextBlock === "string" && saved.cities) state = { ...state, ...saved };
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`index file ${file} could not be read (${e?.message}); starting from the factory's deploy block`);
    }
  }
  state.extras ??= {};
  state.backfill ??= [];
  state.markets ??= {};
  {
    // A contract added after the index already walked past its first block is read once more, from that block up to
    // where the main walk is, as a separate backfill job; the main walk includes it from now on.
    const added = c.extras.filter((x) => !state.extras[lower(x.address)]);
    const next = BigInt(state.nextBlock);
    const behind = added.filter((x) => x.fromBlock < next);
    if (behind.length) {
      const from = behind.reduce((m, x) => (x.fromBlock < m ? x.fromBlock : m), next);
      state.backfill.push({ addresses: behind.map((x) => x.address), next: from.toString(), to: (next - 1n).toString() });
    }
    for (const x of added) state.extras[lower(x.address)] = true;
  }
  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  }

  async function timestampOf(blockNumber) {
    const key = blockNumber.toString();
    if (!blockTime.has(key)) {
      const block = await publicClient.getBlock({ blockNumber });
      blockTime.set(key, Number(block.timestamp));
      if (blockTime.size > 5000) blockTime.delete(blockTime.keys().next().value);
    }
    return blockTime.get(key);
  }

  function cityOf(vault) {
    return state.cities[lower(vault)];
  }

  function addToLedger(city, entry) {
    city.ledger.push(entry);
    if (city.ledger.length > LEDGER_CAP) city.ledger.splice(0, city.ledger.length - LEDGER_CAP);
  }

  function registerCity(log) {
    const a = log.args;
    const key = lower(a.vault);
    if (state.cities[key]) return false;
    state.cities[key] = { vault: getAddress(a.vault), mayor: getAddress(a.mayor), name: a.name, community: a.community, createdBlock: log.blockNumber.toString(), holders: {}, depositors: [], deposits: 0, withdrawals: 0, depositedAssets: "0", withdrawnAssets: "0", ledger: [] };
    return true;
  }

  /** Block timestamps for every event that goes into a ledger. Fetched before anything is applied, so a failed lookup
   * leaves the state untouched and the chunk can simply be retried. */
  async function prefetchTimestamps(logs) {
    const blocks = new Map();
    for (const log of logs) if ((log.eventName !== "Transfer" && log.eventName !== "CityCreated" && cityOf(log.address)) || roles.has(lower(log.address))) blocks.set(log.blockNumber.toString(), log.blockNumber);
    await Promise.all([...blocks.values()].map((b) => timestampOf(b)));
  }

  /**
   * One ledger entry per use of a service. A use is a ServiceUsed (the money: volume and fee) plus at most one detail event
   * (TokenLaunched, Traded or Predicted) from the same transaction, in either order; they are paired in order of appearance.
   */
  function useEntry(uses, log, city, at) {
    const key = `${log.transactionHash}:${lower(city.vault)}`;
    const list = uses.get(key) ?? [];
    uses.set(key, list);
    return {
      forMoney() {
        let e = list.find((x) => !x.used);
        if (!e) {
          e = { type: "service", ...at() };
          list.push(e);
          addToLedger(city, e);
        }
        return e;
      },
      forDetail() {
        let e = list.find((x) => x.type === "service");
        if (!e) {
          e = { type: "service", used: false, ...at() };
          list.push(e);
          addToLedger(city, e);
        }
        return e;
      },
    };
  }

  /** Events of the guardian, the marketplace and CityServices; their address is not the city's. */
  function applyExtra(log, role, ctx, at) {
    const a = log.args;
    const n = (v) => Number(v);
    if (role === "market" && log.eventName === "Hired") {
      ctx.hires.set(log.transactionHash, { listingId: a.listingId.toString(), agentId: a.agentId.toString(), client: getAddress(a.client), paidToAgent: a.paidToAgent, fee: a.fee });
      return;
    }
    if (role === "guardian" && log.eventName === "AgentGranted") {
      const city = cityOf(a.city);
      if (!city) return;
      const hire = ctx.hires.get(log.transactionHash);
      // A grant without a payment in the same transaction is the mayor's free `grantAgent`: a hire worth 0.
      addToLedger(city, { type: "hire", ...at(), agent: getAddress(a.agent), role: n(a.role), expiry: n(a.expiry), user: hire?.client ?? city.mayor, amount: hire ? (hire.paidToAgent + hire.fee).toString() : "0", paid: Boolean(hire), ...(hire ? { listingId: hire.listingId, agentId: hire.agentId } : {}) });
      return;
    }
    if (role !== "services") return;
    const marketCity = (id) => {
      const m = state.markets[id.toString()];
      return m ? cityOf(m.city) : null;
    };
    switch (log.eventName) {
      case "ServiceSet": {
        const city = cityOf(a.city);
        if (!city) return;
        city.services ??= {};
        city.services[n(a.kind)] = { on: a.on, feeBps: n(a.feeBps), block: log.blockNumber.toString() };
        addToLedger(city, { type: "service-set", ...at(), kind: n(a.kind), service: KIND_NAMES[n(a.kind)] ?? null, on: a.on, feeBps: n(a.feeBps) });
        return;
      }
      case "ServiceUsed": {
        const city = cityOf(a.city);
        if (!city) return;
        city.serviceFeeTotal = (BigInt(city.serviceFeeTotal ?? "0") + a.fee).toString();
        Object.assign(useEntry(ctx.uses, log, city, at).forMoney(), { used: true, kind: n(a.kind), service: KIND_NAMES[n(a.kind)] ?? null, user: getAddress(a.user), amount: a.volume.toString(), fee: a.fee.toString() });
        return;
      }
      case "TokenLaunched": {
        const city = cityOf(a.city);
        if (!city) return;
        city.tokens ??= [];
        city.tokens.push({ token: getAddress(a.token), name: a.name, symbol: a.symbol, creator: getAddress(a.creator), ...at() });
        if (city.tokens.length > TOKENS_CAP) city.tokens.splice(0, city.tokens.length - TOKENS_CAP);
        Object.assign(useEntry(ctx.uses, log, city, at).forDetail(), { type: "launch", token: getAddress(a.token), name: a.name, symbol: a.symbol, creator: getAddress(a.creator) });
        return;
      }
      case "Traded": {
        const city = cityOf(a.city);
        if (!city) return;
        Object.assign(useEntry(ctx.uses, log, city, at).forDetail(), { type: "trade", token: getAddress(a.token), buy: a.buy, ausd: a.ausd.toString(), tokens: a.tokens.toString() });
        return;
      }
      case "MarketOpened": {
        const city = cityOf(a.city);
        if (!city) return;
        const m = { id: a.id.toString(), city: city.vault, sourceId: a.sourceId, thresholdBps: n(a.thresholdBps), closesAt: n(a.closesAt), resolvesAt: n(a.resolvesAt), resolved: false, ...at() };
        state.markets[m.id] = m;
        addToLedger(city, { type: "market-open", ...at(), marketId: m.id, sourceId: m.sourceId, thresholdBps: m.thresholdBps, closesAt: m.closesAt, resolvesAt: m.resolvesAt });
        return;
      }
      case "Predicted": {
        const city = marketCity(a.id);
        if (!city) return;
        Object.assign(useEntry(ctx.uses, log, city, at).forDetail(), { type: "predict", marketId: a.id.toString(), above: a.above });
        return;
      }
      case "MarketResolved": {
        const m = state.markets[a.id.toString()];
        const city = marketCity(a.id);
        if (!m || !city) return;
        Object.assign(m, { resolved: true, outcome: n(a.outcome), apyBps: n(a.apyBps) });
        addToLedger(city, { type: "market-resolved", ...at(), marketId: m.id, outcome: n(a.outcome), apyBps: n(a.apyBps) });
        return;
      }
      case "Claimed": {
        const city = marketCity(a.id);
        if (!city) return;
        addToLedger(city, { type: "claim", ...at(), marketId: a.id.toString(), user: getAddress(a.user), amount: a.amount.toString() });
        return;
      }
      case "FeesReleased": {
        const city = cityOf(a.city);
        if (!city) return;
        addToLedger(city, { type: "fees-released", ...at(), amount: a.amount.toString() });
        return;
      }
      default:
        return;
    }
  }

  /** Applies one chunk's logs, oldest first. Synchronous on purpose: nothing can fail halfway through. */
  function apply(logs) {
    const ordered = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    const ctx = { hires: new Map(), uses: new Map() };
    for (const log of ordered) {
      const a = log.args;
      if (log.eventName === "CityCreated") continue; // registered before the chunk is applied
      const role = roles.get(lower(log.address));
      if (role) {
        applyExtra(log, role, ctx, () => ({ block: log.blockNumber.toString(), li: log.logIndex, tx: log.transactionHash, ts: blockTime.get(log.blockNumber.toString()) }));
        continue;
      }
      const city = cityOf(log.address);
      if (!city) continue;
      const at = () => ({ block: log.blockNumber.toString(), li: log.logIndex, tx: log.transactionHash, ts: blockTime.get(log.blockNumber.toString()) });
      switch (log.eventName) {
        case "Transfer": {
          const value = a.value;
          if (a.from !== ZERO) city.holders[lower(a.from)] = (BigInt(city.holders[lower(a.from)] ?? "0") - value).toString();
          if (a.to !== ZERO) city.holders[lower(a.to)] = (BigInt(city.holders[lower(a.to)] ?? "0") + value).toString();
          for (const who of [a.from, a.to]) if (who !== ZERO && BigInt(city.holders[lower(who)] ?? "0") <= 0n) delete city.holders[lower(who)];
          break;
        }
        case "Deposit":
          city.deposits += 1;
          city.depositedAssets = (BigInt(city.depositedAssets) + a.assets).toString();
          if (!city.depositors.includes(lower(a.owner))) city.depositors.push(lower(a.owner));
          addToLedger(city, { type: "deposit", ...at(), owner: getAddress(a.owner), assets: a.assets.toString(), shares: a.shares.toString() });
          break;
        case "Withdraw":
          city.withdrawals += 1;
          city.withdrawnAssets = (BigInt(city.withdrawnAssets) + a.assets).toString();
          addToLedger(city, { type: "withdraw", ...at(), owner: getAddress(a.owner), assets: a.assets.toString(), shares: a.shares.toString() });
          break;
        case "Rebalanced":
          addToLedger(city, { type: "rebalance", ...at(), caller: getAddress(a.caller), from: getAddress(a.from), to: getAddress(a.to), amount: a.amount.toString(), planHash: a.planHash });
          break;
        case "Evacuated":
          addToLedger(city, { type: "evacuate", ...at(), adapter: getAddress(a.adapter), amount: a.amount.toString() });
          break;
        case "FeeAccrued":
          addToLedger(city, { type: "fee", ...at(), feeShares: a.feeShares.toString(), platformShares: a.platformShares.toString(), mayorShares: a.mayorShares.toString(), highWaterMark: a.newHighWaterMark.toString() });
          break;
        case "PlanKeyRevealed":
          addToLedger(city, { type: "reveal", ...at(), entryId: a.entryId });
          break;
        default:
          break;
      }
    }
  }

  function addresses() {
    return [c.factory, ...Object.values(state.cities).map((x) => x.vault), ...c.extras.map((x) => x.address)];
  }

  /** Reads a range of logs; if the RPC refuses it (too many results, too slow), halves the range down to one block. */
  async function fetchChunk(fromBlock, toBlock, address = addresses()) {
    try {
      const logs = await logsClient.getLogs({ address, fromBlock, toBlock });
      return parseEventLogs({ abi: indexAbi, logs, strict: false });
    } catch (e) {
      if (fromBlock >= toBlock) throw e;
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...(await fetchChunk(fromBlock, mid, address)), ...(await fetchChunk(mid + 1n, toBlock, address))];
    }
  }

  /** After a backfill chunk the ledgers hold older events at the end: put them back in chain order. */
  function sortLedgers() {
    for (const city of Object.values(state.cities)) {
      city.ledger.sort((x, y) => (x.block === y.block ? (x.li ?? 0) - (y.li ?? 0) : BigInt(x.block) < BigInt(y.block) ? -1 : 1));
    }
  }

  const backfillLeft = () => state.backfill.reduce((sum, j) => sum + (BigInt(j.to) >= BigInt(j.next) ? BigInt(j.to) - BigInt(j.next) + 1n : 0n), 0n);

  /** Every city, in pages (the factory call is capped per request), up to a sane bound. */
  async function allInfos() {
    const count = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "cityCount" });
    const infos = [];
    for (let start = 0n; start < count && start < 500n; start += 50n) {
      infos.push(...(await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "cityInfos", args: [start, 50n] })));
    }
    return infos;
  }

  async function takeSnapshots() {
    const t = Math.floor(now() / 1000);
    if (t - state.lastSnapshotAt < c.snapshotIntervalSeconds) return false;
    const infos = await allInfos();
    for (const info of infos) {
      const key = lower(info.vault);
      const list = (state.snapshots[key] ??= []);
      list.push({ ts: t, pps: info.pricePerShare.toString(), tvl: info.totalAssets.toString() });
      if (list.length > SNAPSHOT_CAP) list.splice(0, list.length - SNAPSHOT_CAP);
    }
    state.lastSnapshotAt = t;
    return true;
  }

  return {
    config: c,

    /** Walks forward from where it stopped, up to `maxRequestsPerStep` chunks. Returns how far it got. */
    async step() {
      head = await publicClient.getBlockNumber();
      if (state.treasury === null) state.treasury = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "platformTreasury" });
      let requests = 0;
      try {
        while (BigInt(state.nextBlock) <= head && requests < c.maxRequestsPerStep) {
          const from = BigInt(state.nextBlock);
          const to = from + c.range - 1n > head ? head : from + c.range - 1n;
          let logs = await fetchChunk(from, to);
          requests += 1;
          const fresh = logs.filter((l) => l.eventName === "CityCreated" && !state.cities[lower(l.args.vault)]);
          if (fresh.length) {
            // New cities appeared in this chunk: their events were not in the address filter, so read the chunk again.
            for (const log of fresh) registerCity(log);
            logs = await fetchChunk(from, to);
            requests += 1;
          }
          await prefetchTimestamps(logs);
          apply(logs);
          state.nextBlock = (to + 1n).toString();
        }
        // Then, with what is left of the budget, the backfill of contracts added later (oldest job first).
        while (state.backfill.length && requests < c.maxRequestsPerStep) {
          const job = state.backfill[0];
          const from = BigInt(job.next);
          const end = BigInt(job.to);
          if (from > end) {
            state.backfill.shift();
            continue;
          }
          const to = from + c.range - 1n > end ? end : from + c.range - 1n;
          const logs = await fetchChunk(from, to, job.addresses);
          requests += 1;
          await prefetchTimestamps(logs);
          apply(logs);
          if (logs.length) sortLedgers();
          job.next = (to + 1n).toString();
          if (to >= end) state.backfill.shift();
        }
        await takeSnapshots().catch((e) => console.error("snapshot failed:", e?.shortMessage || e?.message || e));
      } finally {
        persist(); // whatever progress was made is kept, also when a request failed halfway
      }
      return { nextBlock: state.nextBlock, head: head.toString(), behind: Number(head >= BigInt(state.nextBlock) ? head - BigInt(state.nextBlock) + 1n : 0n), backfill: Number(backfillLeft()), requests };
    },

    status() {
      const behind = head >= BigInt(state.nextBlock) ? head - BigInt(state.nextBlock) + 1n : 0n;
      return { enabled: true, startBlock: c.startBlock.toString(), indexedToBlock: (BigInt(state.nextBlock) - 1n).toString(), headBlock: head.toString(), behindBlocks: Number(behind), complete: head > 0n && behind <= 2n * c.range, cities: Object.keys(state.cities).length, contracts: c.extras.map((x) => ({ role: x.role, address: x.address })), backfillBlocks: Number(backfillLeft()) };
    },

    /** Prediction markets that are not settled yet, for the resolver. */
    openMarkets() {
      return Object.values(state.markets).filter((m) => !m.resolved).map((m) => ({ id: m.id, city: m.city, sourceId: m.sourceId, closesAt: m.closesAt, resolvesAt: m.resolvesAt }));
    },

    /** Cities that ever earned a service fee: the only ones that can have streamed fees to release. */
    serviceCities() {
      return Object.values(state.cities).filter((x) => BigInt(x.serviceFeeTotal ?? "0") > 0n).map((x) => x.vault);
    },

    /**
     * GET /history/:city: what happened in the city over the last `days` days (1 to 30), newest first, with totals.
     * All amounts are AUSD base units (6 decimals) as strings. `traffic` is the value of users' transactions with the city:
     * deposits, withdrawals, services used (volume) and staff hires paid; the mayor's rebalances are counted apart.
     * `outsideTraffic` and `uniqueUsers` leave out the mayor's own address. Returns null for a city the index does not know.
     */
    history(vault, days = 7) {
      const city = cityOf(vault);
      if (!city) return null;
      const d = Math.min(30, Math.max(1, Math.floor(Number(days)) || 7));
      const to = Math.floor(now() / 1000);
      const from = to - d * 86_400;
      const mayor = lower(city.mayor);
      const t = { traffic: 0n, trafficCount: 0, outsideTraffic: 0n, deposits: 0n, depositCount: 0, withdrawals: 0n, withdrawalCount: 0, serviceVolume: 0n, serviceFees: 0n, serviceUses: 0, feesReleased: 0n, rebalanceVolume: 0n, rebalanceCount: 0, hires: 0, hirePayments: 0n, feeMints: 0 };
      const users = new Set();
      const events = [];
      const traffic = (who, amount) => {
        t.traffic += amount;
        t.trafficCount += 1;
        if (who && lower(who) !== mayor) {
          t.outsideTraffic += amount;
          users.add(lower(who));
        }
      };
      const inWindow = city.ledger.filter((e) => typeof e.ts === "number" && e.ts >= from);
      for (const e of inWindow) {
        const { li, ...rest } = e;
        void li;
        let out = rest;
        switch (e.type) {
          case "deposit":
            t.deposits += BigInt(e.assets);
            t.depositCount += 1;
            traffic(e.owner, BigInt(e.assets));
            out = { ...rest, user: e.owner, amount: e.assets };
            break;
          case "withdraw":
            t.withdrawals += BigInt(e.assets);
            t.withdrawalCount += 1;
            traffic(e.owner, BigInt(e.assets));
            out = { ...rest, user: e.owner, amount: e.assets };
            break;
          case "rebalance":
            t.rebalanceVolume += BigInt(e.amount);
            t.rebalanceCount += 1;
            out = { ...rest, user: e.caller };
            break;
          case "hire":
            t.hires += 1;
            t.hirePayments += BigInt(e.amount);
            traffic(e.user, BigInt(e.amount));
            break;
          case "fees-released":
            t.feesReleased += BigInt(e.amount);
            break;
          case "fee":
            t.feeMints += 1;
            break;
          default:
            if (e.used) {
              t.serviceVolume += BigInt(e.amount);
              t.serviceFees += BigInt(e.fee);
              t.serviceUses += 1;
              traffic(e.user, BigInt(e.amount));
            }
        }
        events.push(out);
      }
      events.reverse();
      const str = (v) => (typeof v === "bigint" ? v.toString() : v);
      const totals = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, str(v)]));
      totals.netFlow = (t.deposits - t.withdrawals).toString();
      totals.uniqueUsers = users.size;
      const oldest = city.ledger[0];
      return {
        city: city.vault,
        name: city.name,
        mayor: city.mayor,
        days: d,
        from,
        to,
        index: this.status(),
        // The ledger keeps the last LEDGER_CAP events of a city; if the oldest kept one is inside the window, older ones are gone.
        truncated: city.ledger.length >= LEDGER_CAP && typeof oldest?.ts === "number" && oldest.ts > from,
        totals,
        services: city.services ?? {},
        markets: Object.values(state.markets).filter((m) => lower(m.city) === lower(city.vault)).slice(-20).reverse().map(({ li, ...m }) => (void li, m)),
        tokens: (city.tokens ?? []).slice(-20).reverse().map(({ li, ...x }) => (void li, x)),
        events: events.slice(0, HISTORY_EVENTS_CAP),
        eventsTruncated: events.length > HISTORY_EVENTS_CAP,
      };
    },

    /**
     * Addresses that count as residents of a city: holders with shares who deposited at some point. Fee shares are minted
     * to the mayor and the platform treasury without a deposit, so they only count if they also deposited (in the demo
     * the deployer is mayor, treasury and depositor at once). Shares that reached someone by a plain transfer, without
     * that person ever depositing, are not counted.
     */
    residentsOf(vault) {
      const city = cityOf(vault);
      if (!city) return [];
      const depositors = new Set(city.depositors);
      return Object.keys(city.holders).filter((holder) => holder !== lower(city.vault) && depositors.has(holder));
    },

    city(vault) {
      return cityOf(vault) ?? null;
    },

    /** True if the address is the mayor of a city or has deposited into one: the people allowed to use the sealed-book store. */
    isParticipant(address) {
      const a = lower(address);
      return Object.values(state.cities).some((city) => lower(city.mayor) === a || city.depositors.includes(a));
    },
    cities: () => Object.values(state.cities),
    snapshotsOf: (vault) => state.snapshots[lower(vault)] ?? [],
    ledgerOf: (vault) => cityOf(vault)?.ledger ?? [],

    /** GET /leaderboard: live TVL and return, indexed resident counts, best return first. */
    async leaderboard() {
      const infos = await allInfos();
      const rows = infos.map((info) => {
        // A city that is empty (or holds only a speck of dust) has a meaningless share price: with no shares left, one
        // leftover unit of yield reads as a 100% return. Only cities with residents' money are ranked.
        const ranked = info.totalAssets >= MIN_RANKED_TVL && info.totalSupply > 0n;
        const returnBps = ranked ? ((info.pricePerShare - PRICE_SCALE) * 10_000n) / PRICE_SCALE : 0n;
        return {
          ranked,
          vault: info.vault,
          name: info.name,
          community: info.community,
          mayor: info.mayor,
          tvl: info.totalAssets.toString(),
          returnBps: Number(returnBps),
          pricePerShare: info.pricePerShare.toString(),
          residents: this.residentsOf(info.vault).length,
          createdAt: Number(info.createdAt),
        };
      });
      rows.sort((x, y) => Number(y.ranked) - Number(x.ranked) || (x.ranked ? y.returnBps - x.returnBps || (BigInt(y.tvl) > BigInt(x.tvl) ? 1 : -1) : y.createdAt - x.createdAt));
      let rank = 0;
      return { asOf: Math.floor(now() / 1000), index: this.status(), minRankedTvl: MIN_RANKED_TVL.toString(), cities: rows.map((r) => ({ rank: r.ranked ? ++rank : null, ...r })) };
    },

    /** GET /metrics: platform-wide numbers for the traction story (BT.4). */
    async metrics() {
      const infos = await allInfos();
      const residents = new Set();
      let deposits = 0;
      let withdrawals = 0;
      for (const info of infos) {
        for (const r of this.residentsOf(info.vault)) residents.add(r);
        const city = cityOf(info.vault);
        deposits += city?.deposits ?? 0;
        withdrawals += city?.withdrawals ?? 0;
      }
      return {
        asOf: Math.floor(now() / 1000),
        index: this.status(),
        cities: infos.length,
        mayors: new Set(infos.map((i) => lower(i.mayor))).size,
        residents: residents.size,
        tvl: infos.reduce((sum, i) => sum + i.totalAssets, 0n).toString(),
        deposits,
        withdrawals,
      };
    },
  };
}
