// Tuned keeper (vault TC67.10): writes the effective APY of every TunedMirrorAdapter clone to ApyFeed under the clone's
// own key, from its on-chain tuning and live mainnet data (formula in src/tuning.mjs).
//
// Clones are found from the factory's city list (`cityInfos` lists each city's adapters); a clone's implementation is
// read from its EIP-1167 bytecode (OpenZeppelin `Clones`), so no event history is needed and new cities are picked up on
// the next round. Each round reads every tuned clone's `tuning()` and writes when the clone was never written, its tuning
// changed, the rate moved by 5 bps or more, or the last write is 6 hours old. A round runs every RUN_TUNED interval
// (default 60 s), so a mayor's change shows within one or two minutes. Writes go through the relayer's ordered sender
// (the relayer key is the feed's updater), which estimates first, so a write that would revert costs no gas.

import { parseAbi } from "viem";
import { SEEDS } from "./catalog.mjs";
import { decodeTuning, effectiveApy, ownSourceId, tuningJson } from "./tuning.mjs";

const factoryAbi = parseAbi([
  "function cityCount() view returns (uint256)",
  "function cityInfos(uint256 start, uint256 count) view returns ((address vault, address mayor, string name, string community, string mapURI, uint16 feeBps, uint64 createdAt, uint256 totalAssets, uint256 totalSupply, uint256 pricePerShare, address[] adapters)[])",
]);
const tunedAbi = parseAbi(["function tuning() view returns (bytes)", "function tunedAt() view returns (uint64)", "function baseSourceId() view returns (bytes32)", "function vault() view returns (address)"]);
const feedAbi = parseAbi([
  "function latest(bytes32 sourceId) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)",
  "function setApy(bytes32 sourceId, uint32 apyBps, uint64 observedAt)",
]);

const lower = (a) => String(a).toLowerCase();
const short = (e) => e?.shortMessage || e?.message || String(e);

/** Implementation address of an EIP-1167 minimal proxy, or null for any other bytecode. */
export function cloneImplementation(code) {
  const c = String(code || "").toLowerCase();
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(c);
  return m ? `0x${m[1]}` : null;
}

/** Same rule as the plain keeper: write when new, changed by `minChangeBps`, or older than `maxAgeSec`. */
export function needsWrite({ effectiveBps, onFeed, tuningChanged, nowSec, minChangeBps = 5, maxAgeSec = 6 * 3600 }) {
  if (!onFeed || onFeed.updatedAt === 0) return true;
  if (tuningChanged) return true;
  if (Math.abs(effectiveBps - onFeed.apyBps) >= minChangeBps) return true;
  return nowSec - onFeed.updatedAt >= maxAgeSec;
}

/**
 * `tunedImpls` = { serviceId: implAddress }. `market` = createMarketData(). `send(request)` = relayer sender (only needed
 * to write). `catalogSeeds` maps a service id to its DefiLlama pool.
 */
export function createTunedKeeper({ publicClient, send = null, factory, feed, tunedImpls, market, seeds = SEEDS, now = () => Date.now(), maxWritesPerRound = 8 }) {
  const serviceByImpl = new Map(Object.entries(tunedImpls).map(([id, impl]) => [lower(impl), id]));
  const poolOf = new Map(seeds.map((s) => [s.id, s.pool]));
  /** adapter -> { adapter, vault, serviceId, ownKey } for tuned clones, or null for any other adapter (cached forever). */
  const known = new Map();
  const lastTuning = new Map();
  const log = [];
  let lastRound = null;
  const note = (entry) => {
    log.push({ at: Math.floor(now() / 1000), ...entry });
    if (log.length > 60) log.splice(0, log.length - 60);
  };

  async function classify(adapter, vault) {
    const key = lower(adapter);
    if (known.has(key)) return known.get(key);
    let info = null;
    try {
      const impl = cloneImplementation(await publicClient.getCode({ address: adapter }));
      const serviceId = impl ? serviceByImpl.get(impl) : null;
      if (serviceId) info = { adapter, vault, serviceId, ownKey: ownSourceId(adapter) };
    } catch {
      return null; // not cached: try again next round
    }
    known.set(key, info);
    return info;
  }

  /** Every tuned clone of every city. */
  async function discover() {
    const count = Number(await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "cityCount" }));
    const out = [];
    for (let start = 0; start < count && start < 500; start += 50) {
      const infos = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "cityInfos", args: [BigInt(start), 50n] });
      for (const info of infos) for (const a of info.adapters) {
        const c = await classify(a, info.vault);
        if (c) out.push(c);
      }
    }
    return out;
  }

  async function readFeed(sourceId) {
    const [apyBps, observedAt, updatedAt] = await publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latest", args: [sourceId] });
    return { apyBps: Number(apyBps), observedAt: Number(observedAt), updatedAt: Number(updatedAt) };
  }

  /** Full view of one tuned clone: tuning, effective APY now, and what the feed holds. */
  async function view(c, marketNow = null) {
    const raw = await publicClient.readContract({ address: c.adapter, abi: tunedAbi, functionName: "tuning" });
    const tuning = decodeTuning(raw);
    const m = marketNow ?? (await market.get());
    const pool = poolOf.get(c.serviceId);
    const res = effectiveApy(c.serviceId, tuning, { pool: m.pools.get(pool) ?? null, lend: m.lend.get(pool) ?? null, monPriceUsd: m.monPriceUsd });
    const onFeed = await readFeed(c.ownKey).catch(() => null);
    return { raw, tuning, res, onFeed, fetchedAt: m.fetchedAt };
  }

  return {
    tunedImpls,
    isTunedImpl: (impl) => serviceByImpl.has(lower(impl)),
    serviceOfImpl: (impl) => serviceByImpl.get(lower(impl)) ?? null,
    classify,
    discover,

    /** GET /tuning/:adapter */
    async describe(adapter) {
      const vault = await publicClient.readContract({ address: adapter, abi: tunedAbi, functionName: "vault" }).catch(() => null);
      const c = await classify(adapter, vault);
      if (!c) return null;
      const [v, baseSourceId] = await Promise.all([view({ ...c, vault: c.vault ?? vault }), publicClient.readContract({ address: adapter, abi: tunedAbi, functionName: "baseSourceId" }).catch(() => null)]);
      return {
        adapter,
        vault: c.vault ?? vault,
        serviceId: c.serviceId,
        baseSourceId,
        ownSourceId: c.ownKey,
        tuning: tuningJson(v.tuning),
        tuningRaw: v.raw,
        effectiveApyBps: v.res.effectiveApyBps,
        uncappedApyBps: v.res.uncappedApyBps,
        inRange: v.res.inRange,
        breakdown: v.res.breakdown,
        notes: v.res.notes,
        onFeed: v.onFeed && v.onFeed.updatedAt ? { apyBps: v.onFeed.apyBps, updatedAt: v.onFeed.updatedAt } : null,
        dataFetchedAt: v.fetchedAt,
      };
    },

    /** One keeper round. Returns what was written. */
    async round() {
      const clones = await discover();
      const m = await market.get();
      if (!m.fetchedAt) throw new Error("DefiLlama Yields is unavailable; tuned adapters not written");
      const head = await publicClient.getBlock();
      const nowSec = Math.floor(now() / 1000);
      const written = [];
      for (const c of clones) {
        if (written.length >= maxWritesPerRound) break;
        try {
          const v = await view(c, m);
          const changed = lastTuning.has(lower(c.adapter)) && lastTuning.get(lower(c.adapter)) !== v.raw;
          if (!lastTuning.has(lower(c.adapter)) && v.onFeed?.updatedAt) {
            // first sight after a restart: treat the tuning as changed only if it is newer than the feed's last write
            const tunedAt = Number(await publicClient.readContract({ address: c.adapter, abi: tunedAbi, functionName: "tunedAt" }).catch(() => 0n));
            lastTuning.set(lower(c.adapter), tunedAt > v.onFeed.updatedAt ? "stale" : v.raw);
          }
          const tuningChanged = changed || lastTuning.get(lower(c.adapter)) === "stale";
          if (!needsWrite({ effectiveBps: v.res.effectiveApyBps, onFeed: v.onFeed, tuningChanged, nowSec })) {
            lastTuning.set(lower(c.adapter), v.raw);
            continue;
          }
          if (!send) continue;
          // The feed refuses observations from the future or older than the stored one.
          let observedAt = BigInt(Math.min(nowSec, Number(head.timestamp)));
          if (v.onFeed && observedAt < BigInt(v.onFeed.observedAt)) observedAt = BigInt(v.onFeed.observedAt);
          const { hash } = await send({ address: feed, abi: feedAbi, functionName: "setApy", args: [c.ownKey, v.res.effectiveApyBps, observedAt] });
          lastTuning.set(lower(c.adapter), v.raw);
          written.push({ adapter: c.adapter, serviceId: c.serviceId, apyBps: v.res.effectiveApyBps, hash });
          note({ adapter: c.adapter, vault: c.vault, serviceId: c.serviceId, status: "written", apyBps: v.res.effectiveApyBps, uncappedApyBps: v.res.uncappedApyBps, tuning: tuningJson(v.tuning), hash });
        } catch (e) {
          note({ adapter: c.adapter, serviceId: c.serviceId, status: "failed", error: short(e).slice(0, 200) });
        }
      }
      lastRound = { at: nowSec, clones: clones.length, written: written.length };
      return written;
    },

    info: () => ({ tunedImpls, lastRound, recent: [...log].reverse() }),
  };
}
