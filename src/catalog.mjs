// The service catalog (backlog B2.28, TC67): the Monad protocols a mayor can put in a city as districts, with live APY and
// TVL, plus the non-yield service kinds of the CityServices contract.
//
// Every yield service is a mirror of one mainnet pool: on testnet a MirrorYieldAdapter clone earns the APY that ApyFeed
// reports for the pool's `sourceId`, which is keccak256 of the DefiLlama pool id (the same rule as web/src/lib/catalog.ts).
// A service can only be picked when founding a city if the factory allows an adapter implementation for it; those
// implementation addresses live in `catalog-impls.json` ({ "<id>": "0x…" }), written after each deployment.
// Numbers come from DefiLlama Yields (`/pools`), cached; on failure the last good reading (or the seed snapshot) is served.
// The first service (Morpho Grove x Steakhouse AUSD) is not in DefiLlama under a pool we could match with certainty, so its
// APY is the one the keeper wrote to ApyFeed (from the vault's on-chain share price) and its TVL is the vault's
// `totalAssets` read on mainnet.

import { readFileSync } from "node:fs";
import { keccak256, parseAbi, toHex } from "viem";

export const YIELDS_URL = "https://yields.llama.fi/pools";
/** Same ceiling as ApyFeed.MAX_APY_BPS (50% a year): a higher APY is shown as is but written to the feed clamped. */
export const FEED_MAX_APY_BPS = 5000;
export const PRIMARY_ID = "morpho-grove";

/** DefiLlama Yields snapshot of 13 Oct 2026 around 22.38 WIB, used until the first live reading (same as the web seeds). */
export const SEEDS = [
  { id: "morpho-grove", name: "Morpho · Grove x Steakhouse AUSD", protocol: "Morpho", category: "bank", asset: "AUSD", pool: "morpho-grove", apyBps: null, tvlUsd: null },
  { id: "aave-ausd", name: "Aave v3 · AUSD", protocol: "Aave v3", category: "bank", asset: "AUSD", pool: "d795cb4c-e30f-52c0-8447-bf0853763a20", apyBps: 584, tvlUsd: 3_161_784 },
  { id: "euler-ausd", name: "Euler v2 · eAUSD", protocol: "Euler v2", category: "bank", asset: "AUSD", pool: "e150c112-d6f3-42f5-8c8d-78580058e1fd", apyBps: 895, tvlUsd: 1_632_724 },
  { id: "curvance-ausd", name: "Curvance · AUSD", protocol: "Curvance", category: "bank", asset: "AUSD", pool: "90924439-8fb8-4e6a-afe3-9ba393e68fdc", apyBps: 600, tvlUsd: 2_186_245 },
  { id: "upshift-earnausd", name: "Upshift · earnAUSD", protocol: "Upshift", category: "vault", asset: "AUSD", pool: "e10580de-1ad2-4bbc-a0e8-ad4db95df4a3", apyBps: 615, tvlUsd: 19_197_987 },
  { id: "curve-ausd-3pool", name: "Curve · AUSD/USDC/USDT0", protocol: "Curve", category: "market", asset: "AUSD", pool: "ceb80408-8ab8-4293-b274-162efff518a6", apyBps: 551, tvlUsd: 2_292_934 },
  { id: "balancer-avusd", name: "Balancer v3 · AVUSD/AUSD", protocol: "Balancer v3", category: "market", asset: "AUSD", pool: "86d04138-6712-5be0-85f4-1d92331ca1d5", apyBps: 885, tvlUsd: 2_060_330 },
  { id: "shmonad", name: "ShMonad · staking MON", protocol: "ShMonad", category: "staking", asset: "MON", pool: "ee40513c-9356-4c53-9f26-446b484a8ae2", apyBps: 1439, tvlUsd: 8_642_117 },
  { id: "accountable-ausd", name: "Accountable · AUSD", protocol: "Accountable", category: "bank", asset: "AUSD", pool: "4baffdfd-8015-4713-bad4-10a199b30157", apyBps: 668, tvlUsd: 100_581_342 },
  { id: "neverland-ausd", name: "Neverland · AUSD", protocol: "Neverland", category: "bank", asset: "AUSD", pool: "ba0f675f-9f14-407b-b278-66d8f59f49ca", apyBps: 941, tvlUsd: 251_540 },
  { id: "morpho-hyperusdc", name: "Morpho · HyperUSDC", protocol: "Morpho", category: "bank", asset: "AUSD", pool: "ec6a71a7-41ae-4e72-942f-b4bc99c3b3cb", apyBps: 745, tvlUsd: 51_778_924 },
  { id: "yuzu-syzusd", name: "Yuzu Money · syzUSD", protocol: "Yuzu Money", category: "vault", asset: "AUSD", pool: "c51e151e-44ad-4f25-9911-102bd00811dc", apyBps: 795, tvlUsd: 10_609_630 },
  { id: "beefy-usdc", name: "Beefy · USDC", protocol: "Beefy", category: "vault", asset: "AUSD", pool: "70f959a9-0167-54b4-a89b-53e35d75cd8e", apyBps: 603, tvlUsd: 3_818_993 },
  { id: "infinifi-siusd", name: "infiniFi · siUSD", protocol: "infiniFi", category: "vault", asset: "AUSD", pool: "9d102f42-e9e8-51dc-9eb4-83e1b02ccd1e", apyBps: 696, tvlUsd: 2_038_540 },
  { id: "pendle-ausd-fixed", name: "Pendle v2 · PT-AUSD (fixed rate)", protocol: "Pendle v2", category: "vault", asset: "AUSD", pool: "653d8a8d-d221-5482-884b-1f936df4cd9e", apyBps: 541, tvlUsd: 2_531_713 },
  { id: "mento-ausd-usdm", name: "Mento · AUSD/USDm", protocol: "Mento", category: "market", asset: "AUSD", pool: "ce74b9e0-376d-45ea-b1a4-362de60c12ce", apyBps: 1349, tvlUsd: 2_322_443 },
  { id: "uniswap-wmon-usdc", name: "Uniswap v3 · WMON/USDC (volatile)", protocol: "Uniswap v3", category: "market", asset: "AUSD", pool: "82b60bc0-ec94-561a-a9e4-c481d47746dd", apyBps: 12_425, tvlUsd: 1_250_673 },
  { id: "kintsu-smon", name: "Kintsu · sMON (staking MON)", protocol: "Kintsu", category: "staking", asset: "MON", pool: "73c511a9-4dc0-4397-babe-e578fd75f0dd", apyBps: 1702, tvlUsd: 1_799_864 },
];

/** Non-yield services sold to outside users through the CityServices contract; the fee is streamed into the city vault. */
export const SERVICE_KINDS = [
  { kind: 1, id: "launchpad", name: "Launchpad", flow: "Visitors launch a token on the city's bonding curve and trade it with AUSD; every launch and trade pays the city's fee, streamed into the city vault over the contract's drip period." },
  { kind: 2, id: "prediction", name: "Prediction market", flow: "The mayor opens a market on whether a Monad protocol's APY (from ApyFeed) ends above a threshold; visitors stake AUSD on a side until betting closes, and the city keeps a fee on every stake (streamed into the vault). The market settles from the feed value written at or after its measurement time." },
];

/** `sourceId` of a catalog service: keccak256 of the DefiLlama pool id; the primary service keeps its deployed id. */
export function sourceIdOf(seed, primarySourceId) {
  return seed.id === PRIMARY_ID && primarySourceId ? primarySourceId : keccak256(toHex(seed.pool));
}

/** APY in percent (DefiLlama) to basis points, never negative. */
export function percentToBps(apy) {
  return typeof apy === "number" && Number.isFinite(apy) && apy > 0 ? Math.round(apy * 100) : 0;
}

/** `{ id: impl }` from the JSON file; anything that is not a plain address is ignored. */
export function loadImpls(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Object.fromEntries(Object.entries(raw ?? {}).filter(([id, a]) => /^[a-z0-9-]{2,40}$/.test(id) && /^0x[0-9a-fA-F]{40}$/.test(String(a))));
  } catch (e) {
    if (e?.code !== "ENOENT") console.error(`catalog: ${file} could not be read (${e?.message})`);
    return {};
  }
}

/** Only the pools of the catalog, out of DefiLlama's ~17,000. */
export function pickPools(data, seeds = SEEDS) {
  const wanted = new Set(seeds.map((s) => s.pool));
  const out = new Map();
  for (const p of Array.isArray(data) ? data : []) if (p && wanted.has(p.pool)) out.set(p.pool, { apyBps: percentToBps(p.apy), tvlUsd: typeof p.tvlUsd === "number" && Number.isFinite(p.tvlUsd) ? Math.round(p.tvlUsd) : null });
  return out;
}

/**
 * Shared DefiLlama Yields reader: one fetch at a time, cached for `ttlMs`, the last good reading kept on failure. The keeper
 * and GET /catalog use the same instance, so a process downloads the 11 MB list at most once per period.
 */
export function createYields({ fetchImpl = fetch, now = () => Date.now(), ttlMs = 15 * 60_000, url = YIELDS_URL, timeoutMs = 45_000 } = {}) {
  let cache = null;
  let inFlight = null;
  let lastError = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`DefiLlama Yields answered ${res.status}`);
      const json = await res.json();
      const pools = pickPools(json?.data);
      if (!pools.size) throw new Error("DefiLlama Yields returned none of the catalog pools");
      cache = { at: now(), fetchedAt: Math.floor(now() / 1000), pools };
      lastError = null;
    } catch (e) {
      lastError = e?.message || String(e);
      console.error("catalog: DefiLlama Yields fetch failed:", lastError);
      // Back off: do not try again on every request while DefiLlama is down.
      if (cache) cache = { ...cache, at: now() - ttlMs + 60_000 };
    }
    return cache;
  }
  return {
    /** `{ fetchedAt, pools: Map<pool, {apyBps, tvlUsd}> }` or null if DefiLlama never answered. */
    async get() {
      if (cache && now() - cache.at < ttlMs) return cache;
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    status: () => ({ fetchedAt: cache?.fetchedAt ?? null, error: lastError }),
  };
}

const feedAbi = parseAbi(["function latest(bytes32 sourceId) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)"]);
const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)"]);

/**
 * GET /catalog. `publicClient` reads ApyFeed on testnet; `mainnetClient` (optional) reads the primary vault's TVL on mainnet.
 * Nothing here can fail the whole answer: each live part falls back to the seed values.
 */
export function createCatalog({ publicClient, mainnetClient = null, yields, feed, primarySourceId, primaryVault = null, mirrorImpl = null, cityServices = null, implsFile, now = () => Date.now(), seeds = SEEDS }) {
  let primaryTvl = { at: 0, value: null };
  async function readPrimaryTvl() {
    if (!mainnetClient || !primaryVault) return null;
    if (now() - primaryTvl.at < 10 * 60_000) return primaryTvl.value;
    try {
      const assets = await mainnetClient.readContract({ address: primaryVault, abi: vaultAbi, functionName: "totalAssets" });
      primaryTvl = { at: now(), value: Math.round(Number(assets) / 1e6) }; // AUSD has 6 decimals and trades at $1
    } catch (e) {
      console.error("catalog: mainnet totalAssets read failed:", e?.shortMessage || e?.message || e);
      primaryTvl = { at: now() - 9 * 60_000, value: primaryTvl.value };
    }
    return primaryTvl.value;
  }
  async function readFeed(sourceId) {
    if (!publicClient || !feed) return null;
    try {
      const [apyBps, observedAt, updatedAt] = await publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latest", args: [sourceId] });
      return updatedAt === 0n ? null : { apyBps: Number(apyBps), observedAt: Number(observedAt), updatedAt: Number(updatedAt) };
    } catch {
      return null;
    }
  }

  return {
    seeds,
    /** Services with an implementation the factory allows, with their sourceIds: what the keeper writes to the feed. */
    sources() {
      const impls = { ...(mirrorImpl ? { [PRIMARY_ID]: mirrorImpl } : {}), ...loadImpls(implsFile) };
      return seeds.filter((s) => impls[s.id]).map((s) => ({ ...s, impl: impls[s.id], sourceId: sourceIdOf(s, primarySourceId) }));
    },
    async get() {
      const impls = { ...(mirrorImpl ? { [PRIMARY_ID]: mirrorImpl } : {}), ...loadImpls(implsFile) };
      const [reading, tvl0] = await Promise.all([yields ? yields.get().catch(() => null) : null, readPrimaryTvl()]);
      const services = await Promise.all(
        seeds.map(async (s) => {
          const sourceId = sourceIdOf(s, primarySourceId);
          const impl = impls[s.id] ?? null;
          const onFeed = impl ? await readFeed(sourceId) : null;
          const live = reading?.pools.get(s.pool) ?? null;
          let apyBps = live?.apyBps ?? s.apyBps;
          let tvlUsd = live?.tvlUsd ?? s.tvlUsd;
          let observedAt = live ? reading.fetchedAt : null;
          let source = live ? "defillama" : "seed";
          if (s.id === PRIMARY_ID) {
            apyBps = onFeed?.apyBps ?? null;
            observedAt = onFeed?.observedAt ?? null;
            tvlUsd = tvl0 ?? null;
            source = onFeed ? "apyfeed" : "none";
          }
          return { id: s.id, name: s.name, protocol: s.protocol, category: s.category, asset: s.asset, pool: s.pool, sourceId, impl, apyBps, tvlUsd, observedAt, source, feed: onFeed, feedClamped: apyBps !== null && apyBps > FEED_MAX_APY_BPS };
        }),
      );
      return {
        asOf: Math.floor(now() / 1000),
        network: "Monad testnet (funds) mirroring Monad mainnet (rates)",
        source: { yields: YIELDS_URL, fetchedAt: reading?.fetchedAt ?? null, ...(yields ? { error: yields.status().error } : {}) },
        note: "Yield is simulated on testnet by MirrorYieldAdapter at the APY ApyFeed reports for the mainnet pool; only services with an `impl` can be picked when founding a city. The feed caps APY at 50%.",
        services,
        // Prediction markets are held back on the deployed contract (`predictionEnabled` is false; vault TC67.8).
        kinds: SERVICE_KINDS.map((k) => ({ ...k, contract: cityServices || null, enabled: k.kind !== 2 })),
      };
    },
  };
}

/** The process-wide DefiLlama Yields reader shared by the keeper and GET /catalog. */
export const sharedYields = createYields();
