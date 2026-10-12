// A small on-chain indexer for the relayer (PRD R12 leaderboard, backlog BT.4 metrics, and the Humas report).
//
// Monad's public RPC limits eth_getLogs to 100 blocks per request, so the indexer walks the chain in chunks from the
// factory's deploy block, remembers how far it got, and keeps only what the product needs:
//   * which cities exist (factory CityCreated) and who their mayors are;
//   * each city's holders, from share Transfer events, so "residents" can be counted;
//   * a short ledger of deposits, withdrawals, rebalances, evacuations, fee mints and key reveals (with timestamps);
//   * hourly snapshots of each city's share price and total assets, so a report can say how a week went.
// TVL and return since founding are always read live from the chain; the index adds what live reads cannot give.
// It is a convenience, not a source of truth: everything it stores can be rebuilt from the chain.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, parseAbi, parseEventLogs } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";
const PRICE_SCALE = 10n ** 18n;
const LEDGER_CAP = 300;
const SNAPSHOT_CAP = 24 * 14;
/** A city is ranked on the leaderboard from 1 AUSD (6 decimals) of assets. */
const MIN_RANKED_TVL = 1_000_000n;

export const indexAbi = parseAbi([
  "event CityCreated(address indexed vault, address indexed mayor, string name, string community, uint16 feeBps, string mapURI)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Rebalanced(address indexed caller, address indexed from, address indexed to, uint256 amount, bytes32 planHash)",
  "event Evacuated(address indexed adapter, uint256 amount)",
  "event FeeAccrued(uint256 feeShares, uint256 platformShares, uint256 mayorShares, uint256 newHighWaterMark)",
  "event PlanKeyRevealed(bytes32 indexed entryId, bytes32 key)",
]);
const factoryAbi = parseAbi([
  "function platformTreasury() view returns (address)",
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
  };
  /** @type {{nextBlock: string, treasury: string | null, cities: Record<string, any>, snapshots: Record<string, {ts: number, pps: string, tvl: string}[]>, lastSnapshotAt: number}} */
  let state = { nextBlock: c.startBlock.toString(), treasury: null, cities: {}, snapshots: {}, lastSnapshotAt: 0 };
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

  /** Applies one chunk's logs, oldest first. */
  async function apply(logs) {
    const ordered = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    for (const log of ordered) {
      const a = log.args;
      if (log.eventName === "CityCreated") continue; // registered before the chunk is applied
      const city = cityOf(log.address);
      if (!city) continue;
      const at = async () => ({ block: log.blockNumber.toString(), tx: log.transactionHash, ts: await timestampOf(log.blockNumber) });
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
          addToLedger(city, { type: "deposit", ...(await at()), owner: getAddress(a.owner), assets: a.assets.toString(), shares: a.shares.toString() });
          break;
        case "Withdraw":
          city.withdrawals += 1;
          city.withdrawnAssets = (BigInt(city.withdrawnAssets) + a.assets).toString();
          addToLedger(city, { type: "withdraw", ...(await at()), owner: getAddress(a.owner), assets: a.assets.toString(), shares: a.shares.toString() });
          break;
        case "Rebalanced":
          addToLedger(city, { type: "rebalance", ...(await at()), caller: getAddress(a.caller), from: getAddress(a.from), to: getAddress(a.to), amount: a.amount.toString(), planHash: a.planHash });
          break;
        case "Evacuated":
          addToLedger(city, { type: "evacuate", ...(await at()), adapter: getAddress(a.adapter), amount: a.amount.toString() });
          break;
        case "FeeAccrued":
          addToLedger(city, { type: "fee", ...(await at()), feeShares: a.feeShares.toString(), platformShares: a.platformShares.toString(), mayorShares: a.mayorShares.toString(), highWaterMark: a.newHighWaterMark.toString() });
          break;
        case "PlanKeyRevealed":
          addToLedger(city, { type: "reveal", ...(await at()), entryId: a.entryId });
          break;
        default:
          break;
      }
    }
  }

  function addresses() {
    return [c.factory, ...Object.values(state.cities).map((x) => x.vault)];
  }

  async function fetchChunk(fromBlock, toBlock) {
    const logs = await logsClient.getLogs({ address: addresses(), fromBlock, toBlock });
    return parseEventLogs({ abi: indexAbi, logs, strict: false });
  }

  async function takeSnapshots() {
    const t = Math.floor(now() / 1000);
    if (t - state.lastSnapshotAt < c.snapshotIntervalSeconds) return false;
    const infos = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "cityInfos", args: [0n, 200n] });
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
        await apply(logs);
        state.nextBlock = (to + 1n).toString();
      }
      await takeSnapshots().catch((e) => console.error("snapshot failed:", e?.shortMessage || e?.message || e));
      persist();
      return { nextBlock: state.nextBlock, head: head.toString(), behind: Number(head >= BigInt(state.nextBlock) ? head - BigInt(state.nextBlock) + 1n : 0n), requests };
    },

    status() {
      const behind = head >= BigInt(state.nextBlock) ? head - BigInt(state.nextBlock) + 1n : 0n;
      return { enabled: true, startBlock: c.startBlock.toString(), indexedToBlock: (BigInt(state.nextBlock) - 1n).toString(), headBlock: head.toString(), behindBlocks: Number(behind), complete: head > 0n && behind <= 2n * c.range, cities: Object.keys(state.cities).length };
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
    cities: () => Object.values(state.cities),
    snapshotsOf: (vault) => state.snapshots[lower(vault)] ?? [],
    ledgerOf: (vault) => cityOf(vault)?.ledger ?? [],

    /** GET /leaderboard: live TVL and return, indexed resident counts, best return first. */
    async leaderboard() {
      const infos = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "cityInfos", args: [0n, 200n] });
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
      const infos = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "cityInfos", args: [0n, 200n] });
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
