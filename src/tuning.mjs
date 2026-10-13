// Protocol tuning (vault TC67.10): a mayor tunes each service the way a depositor could in the real protocol, and the
// city's TunedMirrorAdapter earns the APY that this tuning would earn on mainnet today.
//
// The tuning is stored on-chain in the adapter (`tuning()`, set only by the mayor or the mayor's live session key) as
//   abi.encode(uint8 version = 1, uint16 loopX100, bool takeRewards, uint16 rangeBps, uint256 centerPriceE8)
// and empty bytes mean the defaults { loopX100: 100, takeRewards: true, rangeBps: 0 (full range), centerPriceE8: 0 }.
// The keeper (src/tuned.mjs) computes the adapter's effective APY with `effectiveApy` below from live mainnet data and
// writes it to ApyFeed under the adapter's own key, keccak256(abi.encode("nusastakes.tuned", adapter)).
//
// Effective APY, all in percent a year, from DefiLlama Yields (`/pools`: apy, apyBase, apyReward), DefiLlama
// `/lendBorrow` (apyBaseBorrow, ltv, borrowable) and the MON price from coins.llama.fi:
//   reward = takeRewards ? apyReward x 0.9 : 0            (10% haircut for claiming and selling the reward token)
//   supply = (apyBase, or apy when DefiLlama gives no split) + reward
//   loop   only where the protocol accepts the asset as collateral (ltv > 0, borrowable, borrow rate known):
//          L = min(loopX100, maxX100) / 100 with maxX100 = min(300, floor(90 / (1 - ltv)));
//          APY = L x supply - (L - 1) x borrow rate
//   range  (Uniswap v3 WMON/USDC only) symmetric multiplicative range r = rangeBps / 10000, capital efficiency
//          E(r) = 1 / (1 - (1 + r)^(-1/2)), full range E = 1. DefiLlama's APY is taken as a ±50% position
//          (an assumption), so APY = base x E(r) / E(0.5); it is 0 while the MON price is outside
//          [center / (1 + r), center x (1 + r)] (no center set = in range).
// The result goes to the feed in basis points, clamped to [0, 5000] (ApyFeed.MAX_APY_BPS): the feed cannot express a
// loss, so a tuning that would lose money is written as 0 and reported as negative in `uncappedApyBps`.

import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

export const TUNING_PARAMS = parseAbiParameters("uint8 version, uint16 loopX100, bool takeRewards, uint16 rangeBps, uint256 centerPriceE8");
export const DEFAULT_TUNING = Object.freeze({ version: 1, loopX100: 100, takeRewards: true, rangeBps: 0, centerPriceE8: 0n });
export const FEED_MAX_APY_BPS = 5000;
export const REWARD_HAIRCUT_BPS = 1000;
export const MAX_LOOP_X100 = 300;
export const RANGE_OPTIONS = [500, 1000, 2500, 5000, 0];
export const REF_RANGE_BPS = 5000;
export const RANGE_SERVICE = "uniswap-wmon-usdc";

export const LEND_BORROW_URL = "https://yields.llama.fi/lendBorrow";
export const MON_PRICE_URL = "https://coins.llama.fi/prices/current/coingecko:monad";

/** The adapter's own ApyFeed key, the same as TunedMirrorAdapter._init. */
export function ownSourceId(adapter) {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["nusastakes.tuned", adapter]));
}

export function encodeTuning(t = {}) {
  const v = { ...DEFAULT_TUNING, ...t };
  return encodeAbiParameters(TUNING_PARAMS, [1, Number(v.loopX100), Boolean(v.takeRewards), Number(v.rangeBps), BigInt(v.centerPriceE8)]);
}

/** Empty or unreadable bytes give the defaults (the adapter then earns as if never tuned). */
export function decodeTuning(hex) {
  if (!hex || hex === "0x") return { ...DEFAULT_TUNING };
  try {
    const [version, loopX100, takeRewards, rangeBps, centerPriceE8] = decodeAbiParameters(TUNING_PARAMS, hex);
    return { version: Number(version), loopX100: Number(loopX100), takeRewards, rangeBps: Number(rangeBps), centerPriceE8 };
  } catch {
    return { ...DEFAULT_TUNING, unreadable: true };
  }
}

/** Plain JSON form of a tuning (bigint as string). */
export const tuningJson = (t) => ({ version: t.version, loopX100: t.loopX100, takeRewards: t.takeRewards, rangeBps: t.rangeBps, centerPriceE8: String(t.centerPriceE8), ...(t.unreadable ? { unreadable: true } : {}) });

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bps = (pct) => Math.round(pct * 100);

/** Capital efficiency of a symmetric multiplicative range r (0 = full range, efficiency 1). */
export function rangeEfficiency(rangeBps) {
  if (!rangeBps) return 1;
  const r = rangeBps / 10_000;
  return 1 / (1 - Math.pow(1 + r, -0.5));
}

/** Whether a lending pool lets a depositor loop the asset, and up to which multiple. */
export function loopRule(lend) {
  const ltv = num(lend?.ltv);
  const borrow = num(lend?.apyBaseBorrow);
  if (!lend) return { allowed: false, reason: "no borrow data for this market", maxX100: 100, ltv: null, borrowPct: null };
  if (!(ltv > 0)) return { allowed: false, reason: "the protocol does not accept this asset as collateral (LTV 0)", maxX100: 100, ltv: ltv ?? 0, borrowPct: borrow };
  if (lend.borrowable === false) return { allowed: false, reason: "the asset cannot be borrowed on this market", maxX100: 100, ltv, borrowPct: borrow };
  if (borrow === null) return { allowed: false, reason: "borrow rate unknown", maxX100: 100, ltv, borrowPct: null };
  return { allowed: true, maxX100: Math.min(MAX_LOOP_X100, Math.floor(90 / (1 - ltv))), ltv, borrowPct: borrow };
}

/**
 * Effective APY of a service under a tuning. `data` = { pool: {apy, apyBase, apyReward} | null, lend: {apyBaseBorrow, ltv,
 * borrowable} | null, monPriceUsd: number | null }. Pure.
 */
export function effectiveApy(serviceId, tuning, data = {}) {
  const t = { ...DEFAULT_TUNING, ...(tuning ?? {}) };
  const pool = data.pool ?? null;
  const notes = [];
  if (!pool || (num(pool.apy) === null && num(pool.apyBase) === null)) {
    return { effectiveApyBps: 0, uncappedApyBps: 0, inRange: null, breakdown: { error: "no live data for this service" }, notes: ["no live data for this service; nothing is written until DefiLlama answers"] };
  }
  const reward = num(pool.apyReward) ?? 0;
  const base = num(pool.apyBase) ?? (num(pool.apy) ?? 0) - reward;
  const rewardTaken = t.takeRewards ? reward * (1 - REWARD_HAIRCUT_BPS / 10_000) : 0;
  const supply = base + rewardTaken;
  const breakdown = { basePct: base, rewardPct: reward, rewardTakenPct: rewardTaken, supplyPct: supply };
  let pct = supply;
  let inRange = null;

  const loop = loopRule(data.lend);
  if (t.loopX100 > 100) {
    if (!loop.allowed) {
      notes.push(`loop ignored: ${loop.reason}`);
      breakdown.loop = { requestedX100: t.loopX100, appliedX100: 100, allowed: false, reason: loop.reason };
    } else {
      const applied = Math.min(t.loopX100, loop.maxX100);
      const L = applied / 100;
      pct = L * supply - (L - 1) * loop.borrowPct;
      breakdown.loop = { requestedX100: t.loopX100, appliedX100: applied, maxX100: loop.maxX100, ltv: loop.ltv, borrowPct: loop.borrowPct };
      if (applied < t.loopX100) notes.push(`loop capped at ${applied / 100}x`);
      if (loop.borrowPct >= supply) notes.push("borrowing costs more than the deposit earns: the loop loses money");
    }
  }

  if (serviceId === RANGE_SERVICE) {
    const factor = rangeEfficiency(t.rangeBps) / rangeEfficiency(REF_RANGE_BPS);
    const center = Number(t.centerPriceE8) / 1e8;
    const price = num(data.monPriceUsd);
    if (t.rangeBps && center > 0 && price !== null) {
      const r = t.rangeBps / 10_000;
      inRange = price >= center / (1 + r) && price <= center * (1 + r);
    } else inRange = true;
    pct = inRange ? pct * factor : 0;
    breakdown.range = { rangeBps: t.rangeBps, factor, refRangeBps: REF_RANGE_BPS, centerUsd: center || null, priceUsd: price, inRange, assumption: "DefiLlama APY taken as a ±50% position" };
    if (!inRange) notes.push("the MON price left the range: the position earns no fees until it is re-centred");
  }

  const uncapped = bps(pct);
  const effective = Math.max(0, Math.min(FEED_MAX_APY_BPS, uncapped));
  if (uncapped > FEED_MAX_APY_BPS) notes.push(`written as ${FEED_MAX_APY_BPS} bps, the feed's ceiling`);
  if (uncapped < 0) notes.push("the feed cannot express a loss: written as 0");
  return { effectiveApyBps: effective, uncappedApyBps: uncapped, inRange, breakdown, notes };
}

/** What a depositor can tune in this service, or null when the protocol gives depositors nothing to tune. */
export function knobsFor(serviceId, category, data = {}) {
  const pool = data.pool ?? null;
  const knobs = {};
  const reward = num(pool?.apyReward) ?? 0;
  const base = num(pool?.apyBase) ?? (num(pool?.apy) ?? 0) - reward;
  if (reward > 0) knobs.rewards = { baseApyBps: bps(base), rewardApyBps: bps(reward), haircutBps: REWARD_HAIRCUT_BPS };
  if (category === "bank") {
    const l = loopRule(data.lend);
    knobs.loop = { allowed: l.allowed, ...(l.allowed ? {} : { reason: l.reason }), maxX100: l.maxX100, supplyApyBps: bps(base + (reward > 0 ? reward * (1 - REWARD_HAIRCUT_BPS / 10_000) : 0)), borrowApyBps: l.borrowPct === null ? null : bps(l.borrowPct), ltv: l.ltv };
  }
  if (serviceId === RANGE_SERVICE) knobs.range = { priceUsd: num(data.monPriceUsd), options: RANGE_OPTIONS, refRangeBps: REF_RANGE_BPS, baseApyBps: bps(num(pool?.apy) ?? base) };
  return Object.keys(knobs).length ? knobs : null;
}

/**
 * Live inputs shared by the catalog, the tuned keeper and the autopilot: DefiLlama `/lendBorrow` (cached 15 min) and the
 * MON price (cached 2 min). The pools come from the shared Yields reader (`yields.get()`), which keeps apy/apyBase/apyReward.
 */
export function createMarketData({ yields, fetchImpl = fetch, now = () => Date.now(), pools = [] } = {}) {
  const wanted = new Set(pools);
  let lend = { at: 0, map: new Map() };
  let price = { at: 0, value: null };
  let lendInFlight = null;
  async function lendBorrow() {
    if (now() - lend.at < 15 * 60_000) return lend.map;
    lendInFlight ??= (async () => {
      try {
        const res = await fetchImpl(LEND_BORROW_URL, { signal: AbortSignal.timeout(45_000) });
        if (!res.ok) throw new Error(`lendBorrow answered ${res.status}`);
        const rows = await res.json();
        const map = new Map();
        for (const r of Array.isArray(rows) ? rows : []) if (r && (!wanted.size || wanted.has(r.pool))) map.set(r.pool, { apyBaseBorrow: num(r.apyBaseBorrow), ltv: num(r.ltv), borrowable: r.borrowable ?? null });
        lend = { at: now(), map };
      } catch (e) {
        console.error("tuning: DefiLlama lendBorrow fetch failed:", e?.message || e);
        lend = { at: now() - 14 * 60_000, map: lend.map }; // retry in about a minute, keep the last good map
      }
      return lend.map;
    })().finally(() => {
      lendInFlight = null;
    });
    return lendInFlight;
  }
  async function monPrice() {
    if (now() - price.at < 2 * 60_000) return price.value;
    try {
      const res = await fetchImpl(MON_PRICE_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`coins answered ${res.status}`);
      const v = (await res.json())?.coins?.["coingecko:monad"]?.price;
      price = { at: now(), value: num(v) ?? price.value };
    } catch (e) {
      console.error("tuning: MON price fetch failed:", e?.message || e);
      price = { at: now() - 90_000, value: price.value };
    }
    return price.value;
  }
  return {
    /** `{ fetchedAt, pools: Map<pool, {apy, apyBase, apyReward, apyBps, tvlUsd}>, lend: Map<pool, ...>, monPriceUsd }` */
    async get() {
      const [reading, lendMap, mon] = await Promise.all([yields ? yields.get().catch(() => null) : null, lendBorrow(), monPrice()]);
      return { fetchedAt: reading?.fetchedAt ?? null, pools: reading?.pools ?? new Map(), lend: lendMap, monPriceUsd: mon };
    },
    /** Inputs of `effectiveApy` for one catalog pool. */
    async forPool(pool) {
      const m = await this.get();
      return { pool: m.pools.get(pool) ?? null, lend: m.lend.get(pool) ?? null, monPriceUsd: m.monPriceUsd, fetchedAt: m.fetchedAt };
    },
  };
}
