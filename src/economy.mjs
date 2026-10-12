// The economic report (PRD R13): fees per sector on Monad, from DefiLlama, with the source and the time it was read.
//
// DefiLlama's fees overview lists every protocol on a chain with its fees over 24 hours, 7 days and 30 days and a
// category. This module groups them by category ("sector"). "Fees" are what DefiLlama counts for each protocol; for
// lending and curator vaults that is total yield paid to depositors, not the protocol's own revenue (its own methodology
// pages say so), which is why the report names the source instead of calling it earnings.

import { HttpError } from "./guards.mjs";

export const DEFILLAMA_URL = "https://api.llama.fi/overview/fees/monad?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Groups the protocols of a DefiLlama fees overview by category. */
export function groupBySector(overview) {
  const sectors = new Map();
  for (const p of overview?.protocols ?? []) {
    const name = p.category || "Other";
    const s = sectors.get(name) ?? { sector: name, fees24h: 0, fees7d: 0, fees30d: 0, protocols: 0, top: [] };
    s.fees24h += num(p.total24h);
    s.fees7d += num(p.total7d);
    s.fees30d += num(p.total30d);
    s.protocols += 1;
    s.top.push({ name: p.displayName || p.name, fees24h: num(p.total24h), fees30d: num(p.total30d) });
    sectors.set(name, s);
  }
  return [...sectors.values()]
    .map((s) => ({
      ...s,
      fees24h: Math.round(s.fees24h),
      fees7d: Math.round(s.fees7d),
      fees30d: Math.round(s.fees30d),
      top: s.top.sort((a, b) => b.fees30d - a.fees30d).slice(0, 3).map((t) => ({ ...t, fees24h: Math.round(t.fees24h), fees30d: Math.round(t.fees30d) })),
    }))
    .sort((a, b) => b.fees30d - a.fees30d);
}

export function createEconomy({ fetchImpl = fetch, now = () => Date.now(), ttlMs = 10 * 60_000, url = DEFILLAMA_URL, timeoutMs = 15_000 } = {}) {
  let cache = null;
  return {
    enabled: true,
    /** GET /economy */
    async get() {
      if (cache && now() - cache.at < ttlMs) return cache.value;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`DefiLlama answered ${res.status}`);
        const overview = await res.json();
        const sectors = groupBySector(overview);
        if (!sectors.length) throw new Error("DefiLlama returned no protocols");
        const value = {
          chain: overview.chain ?? "Monad",
          source: "DefiLlama fees overview (dataType=dailyFees)",
          sourceUrl: url,
          fetchedAt: Math.floor(now() / 1000),
          unit: "USD",
          note: "Fees as DefiLlama counts them per protocol; for lending and curator vaults this is yield paid to depositors, not protocol revenue.",
          totals: { fees24h: Math.round(num(overview.total24h)), fees7d: Math.round(num(overview.total7d)), fees30d: Math.round(num(overview.total30d)) },
          sectors,
          stale: false,
        };
        cache = { at: now(), value };
        return value;
      } catch (e) {
        if (cache) return { ...cache.value, stale: true };
        throw new HttpError(502, `economic data is unavailable: ${e?.message || e}`);
      }
    },
  };
}
