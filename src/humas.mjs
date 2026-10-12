// The Humas ("public relations"): an AI staff member that writes a city's report in Indonesian from on-chain events
// (PRD R21). It only reads: it sends no transactions and holds no key. A mayor "hires" it like the other staff by
// granting its address the HUMAS role in CityGuardian, and reports are produced only for cities that did.
//
// The numbers come from the indexer (events and hourly price snapshots) and from live reads; the facts are laid out by
// `buildFacts`, written into a plain report by `templateReport`, and optionally rewritten by an LLM that must keep the
// key figures (otherwise the template stands).

import { getAddress, parseAbi } from "viem";
import { formatAssets, formatPercent, askForReasonAny } from "./analyst.mjs";
import { HttpError, createRateLimiter } from "./guards.mjs";

export const HUMAS_ROLE = 3;
const PRICE_SCALE = 10n ** 18n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const guardianAbi = parseAbi(["function isActiveAgent(address city, address agent, uint8 role) view returns (bool)"]);
const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)", "function pricePerShare() view returns (uint256)"]);

const wibDate = (seconds) => new Date((seconds + 7 * 3600) * 1000).toISOString().slice(0, 10);
const wibTime = (seconds) => new Date((seconds + 7 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
const signed = (bps) => `${bps < 0n ? "-" : ""}${formatPercent(bps < 0n ? -bps : bps)}`;

/** Lays out the figures of one reporting period. Pure: everything it needs is passed in. */
export function buildFacts({ city, name, days, now, ledger, snapshots, live, residents, planReasons, sealedHashes, vaultAdapters = {} }) {
  const to = now;
  const from = now - days * 86400;
  const inPeriod = ledger.filter((e) => e.ts >= from && e.ts <= to);
  const inside = snapshots.filter((s) => s.ts >= from && s.ts <= to);
  const first = inside[0] ?? null;
  const startPps = first ? BigInt(first.pps) : null;
  const startTvl = first ? BigInt(first.tvl) : null;
  const endPps = live.pricePerShare;
  const returnBps = startPps && startPps > 0n ? ((endPps - startPps) * 10_000n) / startPps : null;
  const sum = (type) => inPeriod.filter((e) => e.type === type).reduce((acc, e) => acc + BigInt(e.assets ?? "0"), 0n);
  const rebalances = inPeriod
    .filter((e) => e.type === "rebalance")
    .map((e) => ({
      ts: e.ts,
      from: e.from,
      to: e.to,
      amount: BigInt(e.amount),
      tx: e.tx,
      reason: planReasons[e.planHash?.toLowerCase()] ?? null,
      sealed: Boolean(sealedHashes[e.planHash?.toLowerCase()]),
    }));
  return {
    city,
    name,
    days,
    from,
    to,
    returnBps,
    startTvl,
    endTvl: live.totalAssets,
    residents,
    deposits: { count: inPeriod.filter((e) => e.type === "deposit").length, assets: sum("deposit") },
    withdrawals: { count: inPeriod.filter((e) => e.type === "withdraw").length, assets: sum("withdraw") },
    rebalances,
    evacuations: inPeriod.filter((e) => e.type === "evacuate").map((e) => ({ ts: e.ts, adapter: e.adapter, amount: BigInt(e.amount) })),
    revealedKeys: inPeriod.filter((e) => e.type === "reveal").length,
    adapterNames: vaultAdapters,
    hasHistory: Boolean(first),
    historyFrom: first ? first.ts : null,
  };
}

/** The report in plain Indonesian, built only from `facts`. */
export function templateReport(f) {
  const lines = [];
  lines.push(`Laporan ${f.days} hari untuk ${f.name} (${wibDate(f.from)} sampai ${wibDate(f.to)}, WIB).`);
  if (f.returnBps === null) {
    lines.push(`Riwayat harga share untuk periode ini belum cukup, jadi hasil periode belum bisa dihitung. Total aset sekarang ${formatAssets(f.endTvl)} AUSD dengan ${f.residents} penduduk.`);
  } else {
    const word = f.returnBps > 0n ? "naik" : f.returnBps < 0n ? "turun" : "tidak berubah";
    lines.push(`Hasil: harga share ${word} ${signed(f.returnBps)}%. Total aset dari ${formatAssets(f.startTvl)} menjadi ${formatAssets(f.endTvl)} AUSD, dengan ${f.residents} penduduk.`);
    // The hourly price history only exists since the indexer started; say so rather than imply a full period.
    if (f.historyFrom !== null && f.historyFrom - f.from > 3600) lines.push(`Catatan: riwayat harga hanya tersedia sejak ${wibTime(f.historyFrom)} WIB, jadi hasil di atas mencakup periode itu, bukan seluruh ${f.days} hari.`);
  }
  lines.push(`Aktivitas: ${f.deposits.count} setoran senilai ${formatAssets(f.deposits.assets)} AUSD dan ${f.withdrawals.count} penarikan senilai ${formatAssets(f.withdrawals.assets)} AUSD.`);
  if (f.rebalances.length === 0) {
    lines.push("Pemindahan dana: tidak ada pada periode ini.");
  } else {
    lines.push(`Pemindahan dana (${f.rebalances.length}):`);
    for (const r of f.rebalances) {
      const direction = BigInt(r.from) === 0n ? "dari kas ke adapter" : BigInt(r.to) === 0n ? "dari adapter kembali ke kas" : "antar adapter";
      const why = r.reason ? `alasan: ${r.reason}` : r.sealed ? "alasan tersimpan di buku strategi tersegel (dibuka walikota di akhir musim)" : "alasan tidak tercatat";
      lines.push(`- ${wibDate(r.ts)}: ${formatAssets(r.amount)} AUSD ${direction}; ${why}`);
    }
  }
  if (f.evacuations.length) lines.push(`Evakuasi Satpam: ${f.evacuations.length} kali, total ${formatAssets(f.evacuations.reduce((s, e) => s + e.amount, 0n))} AUSD ditarik kembali ke kas.`);
  if (f.revealedKeys) lines.push(`Walikota membuka ${f.revealedKeys} entri buku strategi untuk diperiksa publik.`);
  lines.push("Sumber: event on-chain kota ini dan snapshot harga tiap jam; angka dalam AUSD.");
  return lines.join("\n");
}

const POLISH_SYSTEM = [
  'You are the Humas ("public relations") on a city\'s AI staff in Nusastakes, a game where each city is an on-chain vault.',
  "You will receive a draft weekly report in Indonesian built from verified figures. Rewrite it as a clear, friendly report of at most 180 words in Indonesian.",
  "Keep every number, date and percentage exactly as written, do not add new figures or promises, and keep the list of fund movements with their reasons.",
  "Reply with the report text only.",
].join(" ");

/** Key figures the rewritten text must still contain, or the template stands. */
export function keepsFigures(text, f) {
  const must = [formatAssets(f.endTvl)];
  if (f.returnBps !== null) must.push(signed(f.returnBps));
  const alt = (s) => [s, s.replace(".", ",")];
  return text.length <= 2500 && must.every((m) => alt(m).some((v) => text.includes(v)));
}

export function createHumas({ publicClient, indexer, address, config, analystStore = null, bookStore = null, llm = [], now = () => Date.now(), ttlMs = 10 * 60_000 }) {
  const humasAddress = getAddress(address);
  const cache = new Map();
  const perIp = createRateLimiter({ windowMs: 60_000, max: 20, now });
  const generation = createRateLimiter({ windowMs: 3_600_000, max: 60, now });
  const providers = (Array.isArray(llm) ? llm : llm ? [llm] : []).filter((p) => p?.apiKey);

  return {
    address: humasAddress,
    info() {
      return { enabled: true, address: humasAddress, role: HUMAS_ROLE, roleName: "HUMAS", llm: providers.length > 0, llmProviders: providers.map((p) => p.provider ?? "anthropic") };
    },

    /** GET /report/:city?days=7 */
    async report(rawCity, rawDays, ctx = {}) {
      if (typeof rawCity !== "string" || !ADDRESS.test(rawCity)) throw new HttpError(400, "city must be a 20-byte hex address");
      const days = rawDays === undefined || rawDays === "" ? 7 : Number(rawDays);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, "days must be a whole number from 1 to 30");
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many report requests from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      const city = getAddress(rawCity);
      const key = `${city}:${days}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;

      const hired = await publicClient.readContract({ address: config.guardian, abi: guardianAbi, functionName: "isActiveAgent", args: [city, humasAddress, HUMAS_ROLE] });
      if (!hired) return { city, status: "not-hired", humas: humasAddress, hint: "the mayor must call CityGuardian.grantAgent(city, humas, 3, expiry)" };
      const known = indexer.city(city);
      if (!known) return { city, status: "unknown-city", index: indexer.status() };
      if (!generation.hit("all")) throw new HttpError(429, "reports are busy, try again shortly", { retryAfterSeconds: 60 });

      const [totalAssets, pricePerShare] = await Promise.all([
        publicClient.readContract({ address: city, abi: vaultAbi, functionName: "totalAssets" }),
        publicClient.readContract({ address: city, abi: vaultAbi, functionName: "pricePerShare" }),
      ]);
      const planReasons = {};
      for (const e of analystStore?.forCity(city) ?? []) planReasons[e.planHash.toLowerCase()] = e.plan.reason;
      const sealedHashes = {};
      if (bookStore) for (const e of bookStore.list(known.mayor).entries) sealedHashes[e.hash.toLowerCase()] = true;
      const facts = buildFacts({
        city,
        name: known.name,
        days,
        now: Math.floor(now() / 1000),
        ledger: indexer.ledgerOf(city),
        snapshots: indexer.snapshotsOf(city),
        live: { totalAssets, pricePerShare },
        residents: indexer.residentsOf(city).length,
        planReasons,
        sealedHashes,
      });
      const draft = templateReport(facts);
      let text = draft;
      let writtenBy = "template";
      if (providers.length) {
        const polished = await askForReasonAny(providers, { draft }, (t) => keepsFigures(t, facts), { system: POLISH_SYSTEM, maxTokens: 900 });
        if (polished) {
          text = polished;
          writtenBy = "llm";
        }
      }
      const value = {
        city,
        status: "ok",
        name: facts.name,
        days,
        period: { from: facts.from, to: facts.to },
        writtenBy,
        text,
        facts: {
          returnBps: facts.returnBps === null ? null : Number(facts.returnBps),
          startTvl: facts.startTvl?.toString() ?? null,
          endTvl: facts.endTvl.toString(),
          residents: facts.residents,
          deposits: { count: facts.deposits.count, assets: facts.deposits.assets.toString() },
          withdrawals: { count: facts.withdrawals.count, assets: facts.withdrawals.assets.toString() },
          rebalances: facts.rebalances.map((r) => ({ ...r, amount: r.amount.toString() })),
          evacuations: facts.evacuations.map((e) => ({ ...e, amount: e.amount.toString() })),
        },
        index: indexer.status(),
      };
      cache.set(key, { at: now(), value });
      return value;
    },
  };
}
