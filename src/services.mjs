// City services sold to outside users (TC67.7): the CityServices contract runs a launchpad (kind 1) and APY prediction
// markets (kind 2) for every city whose mayor switched them on. Each use pays the city's fee; the fee is streamed into the
// city vault over the contract's drip period, so residents (and the mayor, through the profit fee) earn from visitors.
//
// This module holds the contract's ABI for the indexer and two optional background jobs that only press permissionless
// buttons:
//   * the resolver (RESOLVER=1) settles prediction markets once their measurement time has passed. A market can only be
//     settled with an ApyFeed value written at or after `resolvesAt`, so it first asks the keeper to write that source;
//   * the releaser (RELEASER=1) calls `release(city)` for cities whose streamed fees have an amount due, at most every
//     30 minutes per city (each use of a service also releases, so this only matters for quiet cities).
// Both send through the relayer's ordered sender, which estimates first, so a call that would revert costs no gas.

import { parseAbi } from "viem";

export const KIND_NAMES = { 1: "launchpad", 2: "prediction" };

export const servicesAbi = parseAbi([
  "event ServiceSet(address indexed city, uint8 indexed kind, bool on, uint16 feeBps)",
  "event ServiceUsed(address indexed city, uint8 indexed kind, address indexed user, uint256 volume, uint256 fee)",
  "event TokenLaunched(address indexed city, address indexed token, address indexed creator, string name, string symbol)",
  "event Traded(address indexed city, address indexed token, address indexed user, bool buy, uint256 ausd, uint256 tokens, uint256 fee)",
  "event MarketOpened(uint256 indexed id, address indexed city, bytes32 indexed sourceId, uint32 thresholdBps, uint64 closesAt, uint64 resolvesAt)",
  "event Predicted(uint256 indexed id, address indexed user, bool above, uint256 amount, uint256 fee)",
  "event MarketResolved(uint256 indexed id, uint8 outcome, uint32 apyBps)",
  "event Claimed(uint256 indexed id, address indexed user, uint256 amount)",
  "event FeesReleased(address indexed city, uint256 amount)",
  "function resolve(uint256 id)",
  "function release(address city)",
  "function releasable(address city) view returns (uint256 due, uint256 pending)",
]);

const feedAbi = parseAbi(["function latest(bytes32 sourceId) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)"]);

const short = (e) => e?.shortMessage || e?.message || String(e);

/**
 * `send(request)` is the relayer's ordered sender; `writeSource(sourceId)` (from the keeper) writes a fresh ApyFeed value
 * for one source and resolves when it is mined. `indexer` provides `openMarkets()` and `serviceCities()`.
 */
export function createServiceJobs({ publicClient, send, indexer, address, feed, writeSource = null, now = () => Date.now(), maxPerScan = 5 }) {
  const lastResolveTry = new Map();
  const lastFeedWrite = new Map();
  const lastRelease = new Map();
  const log = [];
  const note = (entry) => {
    log.push({ at: Math.floor(now() / 1000), ...entry });
    if (log.length > 50) log.splice(0, log.length - 50);
  };

  async function resolveDue() {
    const t = Math.floor(now() / 1000);
    const due = indexer.openMarkets().filter((m) => m.resolvesAt <= t);
    const done = [];
    for (const m of due.slice(0, maxPerScan)) {
      if (now() - (lastResolveTry.get(m.id) ?? 0) < 120_000) continue;
      lastResolveTry.set(m.id, now());
      try {
        // The contract settles only with a feed value written at or after resolvesAt: make sure there is one.
        const [, , updatedAt] = await publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latest", args: [m.sourceId] });
        if (Number(updatedAt) < m.resolvesAt) {
          if (!writeSource) {
            note({ market: m.id, status: "waiting-for-feed" });
            continue;
          }
          if (now() - (lastFeedWrite.get(m.sourceId) ?? 0) < 120_000) continue;
          lastFeedWrite.set(m.sourceId, now());
          await writeSource(m.sourceId);
        }
        const { hash } = await send({ address, abi: servicesAbi, functionName: "resolve", args: [BigInt(m.id)] });
        note({ market: m.id, status: "resolved", hash });
        done.push({ market: m.id, hash });
      } catch (e) {
        note({ market: m.id, status: "failed", error: short(e).slice(0, 200) });
      }
    }
    return done;
  }

  async function releaseDue() {
    const done = [];
    let sent = 0;
    for (const city of indexer.serviceCities()) {
      if (sent >= maxPerScan) break;
      if (now() - (lastRelease.get(city) ?? 0) < 30 * 60_000) continue;
      try {
        const [due] = await publicClient.readContract({ address, abi: servicesAbi, functionName: "releasable", args: [city] });
        if (due === 0n) continue;
        lastRelease.set(city, now());
        sent += 1;
        const { hash } = await send({ address, abi: servicesAbi, functionName: "release", args: [city] });
        note({ city, status: "released", due: due.toString(), hash });
        done.push({ city, hash });
      } catch (e) {
        lastRelease.set(city, now());
        note({ city, status: "release-failed", error: short(e).slice(0, 200) });
      }
    }
    return done;
  }

  return { resolveDue, releaseDue, info: () => ({ address, recent: [...log].reverse() }) };
}
