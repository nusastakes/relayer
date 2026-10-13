// City score (vault TC67.8): how big and busy a city looks is computed from its services, never chosen. Everything below
// comes from what happened in this one city, so anyone can recompute it from the chain:
//
//   * variety  how many KINDS of service the city runs: bank, vault, staking, market (its yield adapters that hold funds,
//              by the catalog category of the adapter's sourceId), launchpad (the city's counter is on in CityServices),
//              staff (an AI agent hired in the last 30 days);
//   * count    how many services are active (each funded adapter, each counter switched on, staff);
//   * economy  wealth (the vault's total assets), income over 7 days (yield seen in the share price plus service fees
//              earned) and outside traffic over 7 days (value of transactions by anyone but the mayor), each on a log
//              scale so a small city still moves.
//
//   score = 90 x economy x (0.5 + 0.5 x variety / KINDS) + min(10, 2 x count)        (0..100)
//   crowd = min(traffic level, wealth level): a city never looks busier than it is rich.
//
// The weights and reference sizes are game parameters (assumptions), not measurements.

import { keccak256, parseAbi, toHex } from "viem";

export const KINDS = ["bank", "vault", "staking", "market", "launchpad", "staff"];
export const STAGES = [
  { id: "empty", min: 0 },
  { id: "village", min: 5 },
  { id: "town", min: 20 },
  { id: "city", min: 40 },
  { id: "metropolis", min: 65 },
];
/** AUSD base units (6 decimals) at which each economy input reaches its full level. */
export const REFERENCE = { wealth: 100_000e6, income: 500e6, traffic: 50_000e6 };
export const WEIGHTS = { wealth: 0.45, income: 0.25, traffic: 0.3 };

const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)", "function adapters() view returns (address[])"]);
const adapterAbi = parseAbi(["function totalAssets() view returns (uint256)", "function sourceId() view returns (bytes32)", "function baseSourceId() view returns (bytes32)"]);

/** 0..1 on a log scale: 0 at nothing, 1 at `ref` or more. */
export function level(amount, ref) {
  const x = Number(amount) / 1e6;
  if (!(x > 0)) return 0;
  return Math.min(1, Math.log10(1 + x) / Math.log10(1 + ref / 1e6));
}

/**
 * Pure part, unit-tested. `adapters` = [{ category, assets }] (category null when unknown), `services` = the city's
 * CityServices state ({ [kind]: { on } }), amounts in AUSD base units (bigint or string).
 */
export function computeScore({ tvl, income7d, outsideTraffic7d, adapters = [], services = {}, staffActive = false }) {
  const active = [];
  for (const a of adapters) if (a.category && BigInt(a.assets) > 0n) active.push(a.category);
  if (services?.[1]?.on) active.push("launchpad");
  if (staffActive) active.push("staff");
  const kinds = [...new Set(active)].filter((k) => KINDS.includes(k));
  const levels = {
    wealth: level(tvl, REFERENCE.wealth),
    income: level(income7d, REFERENCE.income),
    traffic: level(outsideTraffic7d, REFERENCE.traffic),
  };
  const economy = WEIGHTS.wealth * levels.wealth + WEIGHTS.income * levels.income + WEIGHTS.traffic * levels.traffic;
  const variety = kinds.length / KINDS.length;
  const bonus = Math.min(10, 2 * active.length);
  const score = Math.round(Math.min(100, 90 * economy * (0.5 + 0.5 * variety) + bonus));
  const stage = [...STAGES].reverse().find((s) => score >= s.min).id;
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    score,
    stage,
    crowd: round(Math.min(levels.traffic, levels.wealth)),
    variety: { kinds, of: KINDS.length },
    activeServices: active.length,
    economy: round(economy),
    levels: { wealth: round(levels.wealth), income: round(levels.income), traffic: round(levels.traffic) },
  };
}

/** Yield over the last `days` days from the hourly share-price snapshots: (pps now / pps then - 1) x assets now. */
export function yieldFromSnapshots(snapshots, nowSec, days = 7) {
  if (!snapshots?.length) return 0n;
  const last = snapshots[snapshots.length - 1];
  const since = nowSec - days * 86_400;
  const first = snapshots.find((s) => s.ts >= since) ?? snapshots[0];
  const p0 = BigInt(first.pps);
  const p1 = BigInt(last.pps);
  if (p0 === 0n || p1 <= p0) return 0n;
  return ((p1 - p0) * BigInt(last.tvl)) / p1;
}

/**
 * Reads what `computeScore` needs: the vault and its adapters from the chain, the share-price snapshots and the 7-day
 * and 30-day history from the indexer, and adapter categories from the catalog (sourceId to category).
 */
export function createScorer({ publicClient, indexer, seeds, primarySourceId, now = () => Date.now() }) {
  const categoryBySource = new Map();
  for (const s of seeds) {
    const id = s.id === "morpho-grove" && primarySourceId ? primarySourceId : keccak256(toHex(s.pool));
    categoryBySource.set(id.toLowerCase(), s.category);
  }

  async function adaptersOf(vault) {
    const list = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "adapters" });
    return Promise.all(
      list.map(async (address) => {
        // A TunedMirrorAdapter's sourceId() is its own feed key; the pool it mirrors is baseSourceId() (plain mirrors revert).
        const [assets, base, own] = await Promise.all([
          publicClient.readContract({ address, abi: adapterAbi, functionName: "totalAssets" }),
          publicClient.readContract({ address, abi: adapterAbi, functionName: "baseSourceId" }).catch(() => null),
          publicClient.readContract({ address, abi: adapterAbi, functionName: "sourceId" }).catch(() => null),
        ]);
        const sourceId = base ?? own;
        return { address, assets: assets.toString(), sourceId, category: sourceId ? categoryBySource.get(sourceId.toLowerCase()) ?? null : null };
      }),
    );
  }

  return {
    /** GET /score/:city. Null for a city the index does not know. */
    async score(vault) {
      const week = indexer.history(vault, 7);
      if (!week) return null;
      const month = indexer.history(vault, 30);
      const [tvl, adapters] = await Promise.all([
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }),
        adaptersOf(vault),
      ]);
      const nowSec = Math.floor(now() / 1000);
      const yield7d = yieldFromSnapshots(indexer.snapshotsOf(vault), nowSec, 7);
      const fees7d = BigInt(week.totals.serviceFees);
      const income7d = yield7d + fees7d;
      const outside = BigInt(week.totals.outsideTraffic);
      const result = computeScore({ tvl, income7d, outsideTraffic7d: outside, adapters, services: week.services, staffActive: Number(month.totals.hires) > 0 });
      return {
        city: week.city,
        name: week.name,
        ...result,
        inputs: {
          tvl: tvl.toString(),
          income7d: income7d.toString(),
          yield7d: yield7d.toString(),
          serviceFees7d: fees7d.toString(),
          outsideTraffic7d: outside.toString(),
          uniqueUsers7d: week.totals.uniqueUsers,
          hires30d: Number(month.totals.hires),
          adapters,
          services: week.services,
        },
        formula: "score = 90 x economy x (0.5 + 0.5 x kinds/6) + min(10, 2 x activeServices); economy = 0.45 wealth + 0.25 income + 0.30 traffic (log levels); crowd = min(traffic, wealth)",
        reference: Object.fromEntries(Object.entries(REFERENCE).map(([k, v]) => [k, String(v)])),
      };
    },
  };
}
