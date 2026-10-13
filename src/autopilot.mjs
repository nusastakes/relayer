// Mayor's rules and the autopilot (vault TC67.10): the mayor writes their own "when X, then Y" rules for the city (or
// enables a preset for the same effect), and the autopilot carries them out as the city's session key.
//
// Trust: the autopilot is just another session key. The vault lets a session key only move money between the city's cash
// and its adapters, within the per-call limit (min(maxShiftBps, sessionKeyMaxShiftBps)) and the hourly budget
// (sessionBudgetBps); a tuned adapter lets it change the tuning. It can never withdraw residents' money. The mayor turns
// it on by calling `setSessionKey(autopilot, expiry, shiftBps)` and off by clearing the key or letting it expire.
//
// Rules are stored by the relayer, signed by the mayor with EIP-712 (same domain as the city style):
//   CityRules { address vault; bytes32 rulesHash; uint256 nonce }   rulesHash = keccak256(utf8(rulesJson))
// The body of PUT /rules/:city is { vault, rulesJson, nonce, signature }; `rulesJson` is the exact string that was hashed.
// Every action records a planHash = keccak256 of the rule and the inputs it saw, also sent on-chain with `rebalance`, so
// anyone can check why the autopilot moved money.
//
// Rule: { id, name, enabled, when: { metric, service?, op: "<" | ">", value }, then, cooldownMin }
//   metric  apy (bps, effective APY of a service), apyGap (bps, best funded-or-not service APY minus this service's),
//           cashPct (bps of the city held as cash), tvl (AUSD units), borrowApy (bps), loopSpread (bps, supply minus borrow
//           rate of a lending service), outOfRange (1 or 0, Uniswap range)
//   service a catalog service id of the city, "any" (first funded service that matches), "worst" (lowest APY funded) or
//           "largest" (most funds); not used by cashPct and tvl
//   then    { action: "move", from: service | "cash" | "worst" | "largest" | "match", to: service | "cash" | "best", pct }
//           pct of what `from` holds, 1..100; or { action: "tune", service | "match", set: { loopX100?, takeRewards?,
//           rangeBps?, recenter? } } on a tuned adapter

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, keccak256, parseAbi, toBytes, verifyTypedData } from "viem";
import { HttpError, Mutex, createRateLimiter } from "./guards.mjs";
import { STYLE_DOMAIN } from "./style.mjs";
import { decodeTuning, effectiveApy, encodeTuning, loopRule, RANGE_SERVICE } from "./tuning.mjs";

export const RULES_DOMAIN = STYLE_DOMAIN;
export const RULES_TYPES = {
  CityRules: [
    { name: "vault", type: "address" },
    { name: "rulesHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};
export const RULES_PRIMARY_TYPE = "CityRules";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^[0-9]{1,30}$/;
const ID = /^[a-z0-9-]{1,40}$/;
const MAX_RULES = 12;
const MAX_JSON = 8000;
export const METRICS = ["apy", "apyGap", "cashPct", "tvl", "borrowApy", "loopSpread", "outOfRange"];
const CITY_METRICS = new Set(["cashPct", "tvl"]);
const SELECTORS = new Set(["any", "worst", "largest"]);
const MIN_MOVE = 10_000n; // 0.01 AUSD

export const PRESETS = [
  {
    id: "chase-apy",
    name: "Chase the best rate",
    description: "When the worst funded service earns more than 1 point less than the best one, move a quarter of it to the best.",
    rules: [{ id: "chase-apy", name: "Chase the best rate", enabled: true, when: { metric: "apyGap", service: "worst", op: ">", value: 100 }, then: { action: "move", from: "worst", to: "best", pct: 25 }, cooldownMin: 60 }],
  },
  {
    id: "keep-cash-20",
    name: "Keep about 20% cash",
    description: "Below 15% cash, bring 10% of the largest service back to cash; above 30% cash, put 10% of the cash to work in the best service.",
    rules: [
      { id: "cash-low", name: "Refill cash", enabled: true, when: { metric: "cashPct", op: "<", value: 1500 }, then: { action: "move", from: "largest", to: "cash", pct: 10 }, cooldownMin: 30 },
      { id: "cash-high", name: "Put idle cash to work", enabled: true, when: { metric: "cashPct", op: ">", value: 3000 }, then: { action: "move", from: "cash", to: "best", pct: 10 }, cooldownMin: 30 },
    ],
  },
  {
    id: "brake",
    name: "Brake when a rate collapses",
    description: "When a funded service earns less than 3% a year, bring half of it back to cash.",
    rules: [{ id: "brake", name: "Brake", enabled: true, when: { metric: "apy", service: "any", op: "<", value: 300 }, then: { action: "move", from: "match", to: "cash", pct: 50 }, cooldownMin: 120 }],
  },
  {
    id: "recenter",
    name: "Re-centre the Uniswap range",
    description: "When the MON price leaves the Uniswap position's range, re-centre the range on the current price.",
    rules: [{ id: "recenter", name: "Re-centre", enabled: true, when: { metric: "outOfRange", service: RANGE_SERVICE, op: ">", value: 0 }, then: { action: "tune", service: RANGE_SERVICE, set: { recenter: true } }, cooldownMin: 30 }],
  },
  {
    id: "unwind-loop",
    name: "Unwind a losing loop",
    description: "When borrowing on Neverland costs more than the deposit earns, take the loop back to 1x.",
    rules: [{ id: "unwind-loop", name: "Unwind loop", enabled: true, when: { metric: "loopSpread", service: "neverland-ausd", op: "<", value: 0 }, then: { action: "tune", service: "neverland-ausd", set: { loopX100: 100 } }, cooldownMin: 60 }],
  },
];

const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

/** Validates a rule list; returns it normalised or throws HttpError(400). */
export function validateRules(rules, serviceIds = null) {
  if (!Array.isArray(rules)) throw new HttpError(400, "rules must be an array");
  if (rules.length > MAX_RULES) throw new HttpError(400, `at most ${MAX_RULES} rules`);
  const known = (s) => !serviceIds || serviceIds.has(s);
  const ids = new Set();
  return rules.map((r, i) => {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== "object") throw new HttpError(400, `${at} must be an object`);
    if (!str(r.id, 40) || !ID.test(r.id)) throw new HttpError(400, `${at}: id must be lowercase letters, digits or -`);
    if (ids.has(r.id)) throw new HttpError(400, `${at}: duplicate id ${r.id}`);
    ids.add(r.id);
    const name = typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f]/g, "").slice(0, 60) : r.id;
    const w = r.when;
    if (!w || !METRICS.includes(w.metric)) throw new HttpError(400, `${at}: when.metric must be one of ${METRICS.join(", ")}`);
    if (w.op !== "<" && w.op !== ">") throw new HttpError(400, `${at}: when.op must be < or >`);
    if (typeof w.value !== "number" || !Number.isFinite(w.value)) throw new HttpError(400, `${at}: when.value must be a number`);
    if (!CITY_METRICS.has(w.metric) && !(typeof w.service === "string" && (SELECTORS.has(w.service) || known(w.service)))) throw new HttpError(400, `${at}: when.service must be a service id, any, worst or largest`);
    const t = r.then;
    let then;
    if (t?.action === "move") {
      const fromOk = typeof t.from === "string" && (["cash", "worst", "largest", "match"].includes(t.from) || known(t.from));
      const toOk = typeof t.to === "string" && (["cash", "best"].includes(t.to) || known(t.to));
      if (!fromOk || !toOk) throw new HttpError(400, `${at}: move needs from (service, cash, worst, largest, match) and to (service, cash, best)`);
      if (t.from === t.to) throw new HttpError(400, `${at}: from and to are the same`);
      if (!(typeof t.pct === "number" && t.pct >= 1 && t.pct <= 100)) throw new HttpError(400, `${at}: pct must be 1..100`);
      then = { action: "move", from: t.from, to: t.to, pct: t.pct };
    } else if (t?.action === "tune") {
      if (!(typeof t.service === "string" && (t.service === "match" || known(t.service)))) throw new HttpError(400, `${at}: tune needs a service`);
      const s = t.set ?? {};
      const set = {};
      if (s.loopX100 !== undefined) {
        if (!Number.isInteger(s.loopX100) || s.loopX100 < 100 || s.loopX100 > 300) throw new HttpError(400, `${at}: loopX100 must be 100..300`);
        set.loopX100 = s.loopX100;
      }
      if (s.takeRewards !== undefined) set.takeRewards = Boolean(s.takeRewards);
      if (s.rangeBps !== undefined) {
        if (![0, 500, 1000, 2500, 5000].includes(s.rangeBps)) throw new HttpError(400, `${at}: rangeBps must be 0, 500, 1000, 2500 or 5000`);
        set.rangeBps = s.rangeBps;
      }
      if (s.recenter) set.recenter = true;
      if (!Object.keys(set).length) throw new HttpError(400, `${at}: tune.set is empty`);
      then = { action: "tune", service: t.service, set };
    } else throw new HttpError(400, `${at}: then.action must be move or tune`);
    const cooldownMin = r.cooldownMin === undefined ? 30 : Number(r.cooldownMin);
    if (!(Number.isInteger(cooldownMin) && cooldownMin >= 1 && cooldownMin <= 1440)) throw new HttpError(400, `${at}: cooldownMin must be 1..1440`);
    return { id: r.id, name, enabled: r.enabled !== false, when: { metric: w.metric, ...(w.service ? { service: w.service } : {}), op: w.op, value: w.value }, then, cooldownMin };
  });
}

/**
 * Pure planner. `state` = { total, cash, services: [{ serviceId, adapter, assets, apyBps, tuned, tuning, loopSpreadBps,
 * borrowApyBps, outOfRange }], limits: { perCall, budgetLeft }, monPriceE8 }. Amounts are bigint (AUSD base units).
 * Returns at most `maxActions` actions; `lastFired` = Map(ruleId -> unix seconds).
 */
export function planActions(rules, state, { nowSec, lastFired = new Map(), maxActions = 2 } = {}) {
  const actions = [];
  let budget = state.limits.budgetLeft;
  const funded = state.services.filter((s) => s.assets > 0n);
  const byApy = [...state.services].sort((a, b) => b.apyBps - a.apyBps);
  const best = byApy[0] ?? null;
  const worstFunded = [...funded].sort((a, b) => a.apyBps - b.apyBps)[0] ?? null;
  const largest = [...funded].sort((a, b) => (b.assets > a.assets ? 1 : b.assets < a.assets ? -1 : 0))[0] ?? null;
  const total = state.total;
  const cashPct = total > 0n ? Number((state.cash * 10_000n) / total) : 0;
  const pick = (sel) => (sel === "worst" ? worstFunded : sel === "largest" ? largest : state.services.find((s) => s.serviceId === sel) ?? null);
  const metric = (m, s) => {
    switch (m) {
      case "apy":
        return s?.apyBps ?? null;
      case "apyGap":
        return s && best ? best.apyBps - s.apyBps : null;
      case "borrowApy":
        return s?.borrowApyBps ?? null;
      case "loopSpread":
        return s?.loopSpreadBps ?? null;
      case "outOfRange":
        return s?.outOfRange === null || s?.outOfRange === undefined ? null : s.outOfRange ? 1 : 0;
      case "cashPct":
        return cashPct;
      case "tvl":
        return Number(total) / 1e6;
      default:
        return null;
    }
  };
  const holds = (v, op, value) => v !== null && (op === "<" ? v < value : v > value);

  for (const rule of rules) {
    if (actions.length >= maxActions) break;
    if (!rule.enabled) continue;
    if (nowSec - (lastFired.get(rule.id) ?? 0) < rule.cooldownMin * 60) continue;
    const w = rule.when;
    let match = null;
    let seen = null;
    if (CITY_METRICS.has(w.metric)) {
      seen = metric(w.metric, null);
      if (!holds(seen, w.op, w.value)) continue;
    } else if (w.service === "any") {
      match = funded.find((s) => holds(metric(w.metric, s), w.op, w.value)) ?? null;
      if (!match) continue;
      seen = metric(w.metric, match);
    } else {
      match = pick(w.service);
      seen = metric(w.metric, match);
      if (!match || !holds(seen, w.op, w.value)) continue;
    }
    const t = rule.then;
    if (t.action === "move") {
      const from = t.from === "cash" ? null : t.from === "match" ? match : pick(t.from);
      if (t.from !== "cash" && !from) continue;
      let to = t.to === "cash" ? null : t.to === "best" ? byApy.find((s) => s !== from) ?? null : pick(t.to);
      if (t.to !== "cash" && !to) continue;
      if (from && to && from.adapter === to.adapter) continue;
      const held = from ? from.assets : state.cash;
      let amount = (held * BigInt(Math.round(t.pct * 100))) / 10_000n;
      if (amount > state.limits.perCall) amount = state.limits.perCall;
      if (amount > budget) amount = budget;
      if (amount < MIN_MOVE) continue;
      budget -= amount;
      actions.push({ ruleId: rule.id, kind: "move", from: from?.adapter ?? null, to: to?.adapter ?? null, fromService: from?.serviceId ?? "cash", toService: to?.serviceId ?? "cash", amount, inputs: { metric: w.metric, service: match?.serviceId ?? null, value: seen, threshold: w.value } });
    } else {
      const target = t.service === "match" ? match : pick(t.service);
      if (!target?.tuned) continue;
      const next = { ...target.tuning };
      if (t.set.loopX100 !== undefined) next.loopX100 = t.set.loopX100;
      if (t.set.takeRewards !== undefined) next.takeRewards = t.set.takeRewards;
      if (t.set.rangeBps !== undefined) next.rangeBps = t.set.rangeBps;
      if (t.set.recenter) {
        if (!state.monPriceE8) continue;
        next.centerPriceE8 = state.monPriceE8;
      }
      const same = next.loopX100 === target.tuning.loopX100 && next.takeRewards === target.tuning.takeRewards && next.rangeBps === target.tuning.rangeBps && BigInt(next.centerPriceE8) === BigInt(target.tuning.centerPriceE8);
      if (same) continue;
      actions.push({ ruleId: rule.id, kind: "tune", adapter: target.adapter, service: target.serviceId, tuning: next, inputs: { metric: w.metric, service: target.serviceId, value: seen, threshold: w.value } });
    }
  }
  return actions;
}

/** planHash of an action: keccak256 of the rule and what it saw, so anyone can check it against the stored record. */
export function planHashOf(city, rule, action, at) {
  return keccak256(toBytes(JSON.stringify({ city: city.toLowerCase(), rule, action: { ...action, amount: action.amount?.toString(), tuning: action.tuning ? { ...action.tuning, centerPriceE8: String(action.tuning.centerPriceE8) } : undefined }, at })));
}

const vaultAbi = parseAbi([
  "function mayor() view returns (address)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function adapters() view returns (address[])",
  "function maxShiftBps() view returns (uint16)",
  "function sessionKey() view returns (address)",
  "function sessionKeyExpiry() view returns (uint64)",
  "function sessionKeyMaxShiftBps() view returns (uint16)",
  "function sessionBudgetBps() view returns (uint16)",
  "function sessionWindowStart() view returns (uint64)",
  "function sessionWindowShifted() view returns (uint256)",
  "function rebalance(address from, address to, uint256 amount, bytes32 planHash)",
]);
const adapterAbi = parseAbi(["function totalAssets() view returns (uint256)", "function sourceId() view returns (bytes32)", "function tuning() view returns (bytes)", "function setTuning(bytes newTuning)"]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const feedAbi = parseAbi(["function latest(bytes32 sourceId) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)"]);
const factoryAbi = parseAbi(["function isCity(address) view returns (bool)"]);

/**
 * @param deps.publicClient     testnet reads
 * @param deps.walletClient     the autopilot's own wallet (AUTOPILOT_PRIVATE_KEY) or null (rules can still be stored)
 * @param deps.factory          CityFactory
 * @param deps.feed             ApyFeed (what a plain mirror adapter earns)
 * @param deps.tuned            createTunedKeeper() (tuned clone lookup)
 * @param deps.market           createMarketData()
 * @param deps.seeds            catalog seeds; deps.sourceIdOfSeed(seed) gives a plain adapter's sourceId
 */
export function createAutopilot({ publicClient, walletClient = null, factory, feed = null, tuned, market, seeds, sourceIdOfSeed, file = null, now = () => Date.now(), verify = verifyTypedData }) {
  const address = walletClient?.account?.address ?? null;
  const serviceIds = new Set(seeds.map((s) => s.id));
  const seedBySource = new Map(seeds.map((s) => [sourceIdOfSeed(s).toLowerCase(), s]));
  const seedById = new Map(seeds.map((s) => [s.id, s]));
  /** city -> { rulesJson, rules, nonce, updatedAt, actions: [], errors: [], lastRun, lastFired: {ruleId: sec} } */
  const cities = new Map();
  const mutex = new Mutex();
  const perIp = createRateLimiter({ windowMs: 60_000, max: 20, now });
  const perVault = createRateLimiter({ windowMs: 60_000, max: 10, now });

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(saved ?? {})) if (ADDRESS.test(k) && typeof v?.rulesJson === "string") cities.set(k.toLowerCase(), { actions: [], errors: [], lastFired: {}, ...v });
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`rules file ${file} could not be read (${e?.message}); starting empty`);
    }
  }
  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(cities)));
    renameSync(`${file}.tmp`, file);
  }
  const record = (key, field, entry, cap = 30) => {
    const c = cities.get(key);
    if (!c) return;
    c[field] = [...(c[field] ?? []), { at: Math.floor(now() / 1000), ...entry }].slice(-cap);
  };

  async function sessionStatus(vault) {
    const [key, expiry] = await Promise.all([
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "sessionKey" }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "sessionKeyExpiry" }),
    ]);
    const nowSec = Math.floor(now() / 1000);
    return { sessionKey: key, sessionKeyExpiry: Number(expiry), autopilotIsSessionKey: Boolean(address) && key.toLowerCase() === address.toLowerCase() && Number(expiry) > nowSec };
  }

  /** Everything the planner needs about one city, read from the chain and live market data. */
  async function cityState(vault) {
    const read = (functionName) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName });
    const [assetAddr, total, list, maxShift, keyShift, budgetBps, windowStart, shifted, block, m] = await Promise.all([
      read("asset"), read("totalAssets"), read("adapters"), read("maxShiftBps"), read("sessionKeyMaxShiftBps"), read("sessionBudgetBps"), read("sessionWindowStart"), read("sessionWindowShifted"), publicClient.getBlock(), market.get(),
    ]);
    const cash = await publicClient.readContract({ address: assetAddr, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
    const services = [];
    for (const adapter of list) {
      const assets = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "totalAssets" });
      const t = tuned ? await tuned.classify(adapter, vault) : null;
      let seed = t ? seedById.get(t.serviceId) : null;
      let plainApy = null;
      if (!seed) {
        const sid = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "sourceId" }).catch(() => null);
        seed = sid ? seedBySource.get(sid.toLowerCase()) ?? null : null;
        // A plain mirror earns what the feed holds for its pool.
        if (seed && feed) plainApy = await publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latest", args: [sid] }).then(([bps]) => Number(bps)).catch(() => null);
      }
      if (!seed) continue;
      const data = { pool: m.pools.get(seed.pool) ?? null, lend: m.lend.get(seed.pool) ?? null, monPriceUsd: m.monPriceUsd };
      const tuning = t ? decodeTuning(await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "tuning" })) : null;
      const eff = t ? effectiveApy(seed.id, tuning, data) : null;
      const apyBps = eff ? eff.effectiveApyBps : plainApy ?? data.pool?.apyBps ?? 0;
      const loop = loopRule(data.lend);
      const supplyBps = eff ? Math.round((eff.breakdown.supplyPct ?? 0) * 100) : data.pool?.apyBps ?? 0;
      services.push({
        serviceId: seed.id,
        adapter,
        assets,
        apyBps,
        tuned: Boolean(t),
        tuning,
        borrowApyBps: loop.borrowPct === null ? null : Math.round(loop.borrowPct * 100),
        loopSpreadBps: loop.allowed ? supplyBps - Math.round(loop.borrowPct * 100) : null,
        outOfRange: eff && eff.inRange !== null ? !eff.inRange : null,
      });
    }
    const nowSec = Number(block.timestamp);
    const limitBps = BigInt(Math.min(Number(maxShift), Number(keyShift)));
    const cap = (total * BigInt(budgetBps)) / 10_000n;
    const windowOver = nowSec >= Number(windowStart) + 3600;
    const budgetLeft = windowOver ? cap : cap > shifted ? cap - shifted : 0n;
    return {
      total,
      cash,
      services,
      limits: { perCall: (total * limitBps) / 10_000n, budgetLeft },
      monPriceE8: m.monPriceUsd ? BigInt(Math.round(m.monPriceUsd * 1e8)) : null,
    };
  }

  async function sendAs(request) {
    const gas = await publicClient.estimateContractGas({ ...request, account: walletClient.account });
    const block = await publicClient.getBlock();
    const fees = block.baseFeePerGas ? { maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + 2_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n } : {};
    const hash = await walletClient.writeContract({ ...request, gas: (gas * 120n) / 100n, ...fees });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return hash;
  }

  return {
    address,
    presets: () => ({ presets: PRESETS }),

    /** GET /rules/:city */
    async get(rawVault) {
      if (typeof rawVault !== "string" || !ADDRESS.test(rawVault)) throw new HttpError(400, "city must be a vault address");
      const key = rawVault.toLowerCase();
      const c = cities.get(key);
      const session = await sessionStatus(rawVault).catch(() => null);
      return {
        vault: rawVault,
        rules: c?.rules ?? [],
        rulesJson: c?.rulesJson ?? "[]",
        nonce: c?.nonce ?? "0",
        updatedAt: c?.updatedAt ?? null,
        status: {
          autopilot: address,
          enabled: Boolean(c?.rules?.some((r) => r.enabled)),
          autopilotIsSessionKey: session?.autopilotIsSessionKey ?? false,
          sessionKey: session?.sessionKey ?? null,
          sessionKeyExpiry: session?.sessionKeyExpiry ?? null,
          lastRun: c?.lastRun ?? null,
          recent: [...(c?.actions ?? [])].reverse(),
          errors: [...(c?.errors ?? [])].reverse().slice(0, 10),
        },
      };
    },

    /** PUT /rules/:city: only the city's mayor, EIP-712 signed, nonce must grow. */
    async set(rawVault, body, ctx = {}) {
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many rule updates from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      if (typeof rawVault !== "string" || !ADDRESS.test(rawVault)) throw new HttpError(400, "city must be a vault address");
      if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
      if (typeof body.vault !== "string" || body.vault.toLowerCase() !== rawVault.toLowerCase()) throw new HttpError(400, "body.vault must be the city in the path");
      if (typeof body.rulesJson !== "string" || body.rulesJson.length > MAX_JSON) throw new HttpError(400, `rulesJson must be a string of at most ${MAX_JSON} characters`);
      const rawNonce = typeof body.nonce === "number" && Number.isSafeInteger(body.nonce) && body.nonce >= 0 ? String(body.nonce) : body.nonce;
      if (typeof rawNonce !== "string" || !UINT.test(rawNonce)) throw new HttpError(400, "nonce must be a non-negative integer");
      if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) throw new HttpError(400, "signature must be 65 bytes of hex");
      let parsed;
      try {
        parsed = JSON.parse(body.rulesJson);
      } catch {
        throw new HttpError(400, "rulesJson is not valid JSON");
      }
      const rules = validateRules(parsed, serviceIds);
      const nonce = BigInt(rawNonce);
      const isCity = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "isCity", args: [rawVault] });
      if (!isCity) throw new HttpError(400, "vault was not created by the city factory");
      const mayor = await publicClient.readContract({ address: rawVault, abi: vaultAbi, functionName: "mayor" });
      const rulesHash = keccak256(toBytes(body.rulesJson));
      const ok = await verify({ address: mayor, domain: RULES_DOMAIN, types: RULES_TYPES, primaryType: RULES_PRIMARY_TYPE, message: { vault: getAddress(rawVault.toLowerCase()), rulesHash, nonce }, signature: body.signature }).catch(() => false);
      if (!ok) throw new HttpError(403, "signature does not come from the city's mayor");
      const key = rawVault.toLowerCase();
      if (!perVault.hit(key)) throw new HttpError(429, "too many rule updates for this city");
      return mutex.run(async () => {
        const prev = cities.get(key);
        if (prev && nonce <= BigInt(prev.nonce)) throw new HttpError(409, `nonce must be greater than ${prev.nonce}`, { currentNonce: prev.nonce });
        cities.set(key, { actions: [], errors: [], lastFired: {}, ...(prev ?? {}), vaultAddress: rawVault, rulesJson: body.rulesJson, rules, nonce: nonce.toString(), rulesHash, updatedAt: Math.floor(now() / 1000) });
        try {
          persist();
        } catch (e) {
          if (prev) cities.set(key, prev);
          else cities.delete(key);
          console.error("rules could not be saved:", e?.message || e);
          throw new HttpError(500, "rules could not be saved");
        }
        return { vault: rawVault, rules, nonce: nonce.toString(), rulesHash };
      });
    },

    /** Dry run for the UI: what the rules would do right now (nothing is sent). */
    async preview(rawVault) {
      if (typeof rawVault !== "string" || !ADDRESS.test(rawVault)) throw new HttpError(400, "city must be a vault address");
      const c = cities.get(rawVault.toLowerCase());
      const state = await cityState(rawVault);
      const actions = planActions(c?.rules ?? [], state, { nowSec: Math.floor(now() / 1000), lastFired: new Map(Object.entries(c?.lastFired ?? {})) });
      return { vault: rawVault, state: serializeState(state), actions: actions.map(serializeAction) };
    },

    /** One autopilot round over every city with enabled rules. */
    async run() {
      if (!walletClient) return [];
      const done = [];
      for (const [key, c] of cities) {
        if (!c.rules?.some((r) => r.enabled)) continue;
        const vault = c.vaultAddress ?? key;
        try {
          const session = await sessionStatus(vault);
          c.lastRun = Math.floor(now() / 1000);
          if (!session.autopilotIsSessionKey) continue;
          const state = await cityState(vault);
          const nowSec = Math.floor(now() / 1000);
          const actions = planActions(c.rules, state, { nowSec, lastFired: new Map(Object.entries(c.lastFired ?? {})) });
          for (const a of actions) {
            const rule = c.rules.find((r) => r.id === a.ruleId);
            const planHash = planHashOf(vault, rule, a, nowSec);
            try {
              const hash =
                a.kind === "move"
                  ? await sendAs({ address: vault, abi: vaultAbi, functionName: "rebalance", args: [a.from ?? "0x0000000000000000000000000000000000000000", a.to ?? "0x0000000000000000000000000000000000000000", a.amount, planHash] })
                  : await sendAs({ address: a.adapter, abi: adapterAbi, functionName: "setTuning", args: [encodeTuning(a.tuning)] });
              c.lastFired = { ...(c.lastFired ?? {}), [a.ruleId]: nowSec };
              record(key, "actions", { ...serializeAction(a), planHash, hash });
              done.push({ city: vault, rule: a.ruleId, hash });
            } catch (e) {
              c.lastFired = { ...(c.lastFired ?? {}), [a.ruleId]: nowSec }; // do not retry a failing rule every round
              record(key, "errors", { rule: a.ruleId, error: (e?.shortMessage || e?.message || String(e)).slice(0, 200) }, 20);
            }
          }
        } catch (e) {
          record(key, "errors", { error: (e?.shortMessage || e?.message || String(e)).slice(0, 200) }, 20);
        }
      }
      try {
        persist();
      } catch (e) {
        console.error("rules could not be saved:", e?.message || e);
      }
      return done;
    },
  };
}

export function serializeAction(a) {
  return {
    ruleId: a.ruleId,
    kind: a.kind,
    ...(a.kind === "move" ? { from: a.from, to: a.to, fromService: a.fromService, toService: a.toService, amount: a.amount.toString() } : { adapter: a.adapter, service: a.service, tuning: { ...a.tuning, centerPriceE8: String(a.tuning.centerPriceE8) } }),
    inputs: a.inputs,
  };
}

function serializeState(s) {
  return {
    total: s.total.toString(),
    cash: s.cash.toString(),
    limits: { perCall: s.limits.perCall.toString(), budgetLeft: s.limits.budgetLeft.toString() },
    monPriceE8: s.monPriceE8?.toString() ?? null,
    services: s.services.map((x) => ({ ...x, assets: x.assets.toString(), tuning: x.tuning ? { ...x.tuning, centerPriceE8: String(x.tuning.centerPriceE8) } : null })),
  };
}
