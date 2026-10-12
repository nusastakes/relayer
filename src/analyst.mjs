// The Analyst ("Analis"): an AI staff member that proposes rebalances for a city. It never moves money by itself.
//
// The flow (PRD R19): the mayor grants this bot's address the ANALIS role in CityGuardian (with an expiry). The bot
// looks at each city where it is allowed to act, and when the rules find something worth doing it calls
// `CityGuardian.propose(city, from, to, amount, planHash)`. Nothing moves until the mayor approves the proposal, which
// runs `rebalance` inside the vault's normal limits (`maxShiftBps`).
//
// The numbers (from, to, amount) always come from the deterministic rules in `decide`. An LLM may only write the
// plain-language reason shown to the mayor, and its text is dropped if it does not contain the amount. The reason and
// the facts behind it are kept off-chain by the relayer; `planHash` = keccak256 of the canonical plan JSON, so anyone can
// check that the stored reason is the one the proposal committed to (`verifyPlan`).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, keccak256, parseAbi, parseEventLogs, toBytes } from "viem";
import { HttpError, Mutex, createRateLimiter } from "./guards.mjs";

/** CityGuardian.Role.ANALIS */
export const ANALIS_ROLE = 2;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BPS = 10_000n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const DEFAULT_PARAMS = {
  /** Cash a city should keep idle for withdrawals, as a share of its assets. */
  idleBufferBps: 2000n,
  /** Below this source APY the yield is not worth the risk and the analyst proposes pulling money back. */
  minApyBps: 50n,
  /** A source APY older than this is not trusted. */
  maxApyAgeSeconds: 7 * 24 * 3600,
  /** Smallest move worth a mayor's tap (6-decimal asset: 1 AUSD). */
  minMove: 1_000_000n,
  /** Propose at most this share of what the vault allows per call, so fee accrual cannot push it over the limit. */
  shiftSafetyBps: 9500n,
};

export const guardianAbi = parseAbi([
  "function isActiveAgent(address city, address agent, uint8 role) view returns (bool)",
  "function propose(address city, address from, address to, uint256 amount, bytes32 planHash) returns (uint256 id)",
  "function proposalCount() view returns (uint256)",
  "function proposals(uint256 id) view returns ((address city, address from, address to, uint256 amount, bytes32 planHash, address proposer, uint64 createdAt, bool approved))",
  "event ProposalCreated(uint256 indexed id, address indexed city, address indexed proposer, address from, address to, uint256 amount, bytes32 planHash)",
]);
const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)", "function adapters() view returns (address[])", "function maxShiftBps() view returns (uint16)"]);
const adapterAbi = parseAbi(["function totalAssets() view returns (uint256)", "function isSimulated() view returns (bool)"]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const feedAbi = parseAbi(["function latest(bytes32 sourceId) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)"]);
const factoryAbi = parseAbi([
  "function cityCount() view returns (uint256)",
  "function cityAt(uint256 index) view returns (address)",
]);

// ------------------------------------------------------------------------------------------------ the rules

/** 6-decimal asset amount as text with two decimals, for example 600000000n -> "600.00". */
export function formatAssets(amount) {
  const cents = amount / 10_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
const formatPercent = (bps) => `${bps / 100n}.${String(bps % 100n).padStart(2, "0")}`;

/**
 * @param {{total: bigint, idle: bigint, maxShiftBps: bigint, apyBps: bigint | null, apyAgeSeconds: number | null,
 *          adapters: {address: string, assets: bigint, simulated: boolean}[]}} snapshot
 * @returns {{action: "none" | "deploy" | "pullback", from?: string, to?: string, amount?: bigint, why: string}}
 */
export function decide(snapshot, overrides = {}) {
  const p = { ...DEFAULT_PARAMS, ...overrides };
  const { total, idle, maxShiftBps, apyBps, apyAgeSeconds, adapters } = snapshot;
  if (total === 0n) return { action: "none", why: "the city holds no assets" };
  // Only adapters whose yield we can read from the APY feed are judged; the others are the mayor's business.
  const known = adapters.filter((a) => a.simulated);
  if (known.length === 0) return { action: "none", why: "no adapter with a known yield" };
  if (apyBps === null || apyAgeSeconds === null) return { action: "none", why: "yield data is missing" };
  if (apyAgeSeconds > p.maxApyAgeSeconds) return { action: "none", why: "yield data is stale" };

  const limit = (((total * maxShiftBps) / BPS) * p.shiftSafetyBps) / BPS;
  if (apyBps >= p.minApyBps) {
    const buffer = (total * p.idleBufferBps) / BPS;
    const deployable = idle > buffer ? idle - buffer : 0n;
    const amount = deployable < limit ? deployable : limit;
    if (amount < p.minMove) return { action: "none", why: "idle cash is already close to the safety buffer" };
    // Spread to the adapter that holds the least.
    const target = [...known].sort((a, b) => (a.assets < b.assets ? -1 : a.assets > b.assets ? 1 : 0))[0];
    return { action: "deploy", from: ZERO_ADDRESS, to: target.address, amount, why: "idle cash is above the safety buffer and the source yields" };
  }
  const holder = [...known].filter((a) => a.assets >= p.minMove).sort((a, b) => (a.assets > b.assets ? -1 : a.assets < b.assets ? 1 : 0))[0];
  if (!holder) return { action: "none", why: "the yield is low but nothing is invested" };
  const amount = holder.assets < limit ? holder.assets : limit;
  if (amount < p.minMove) return { action: "none", why: "the amount to move is too small" };
  return { action: "pullback", from: holder.address, to: ZERO_ADDRESS, amount, why: "the source yield fell below the minimum" };
}

/** Reason in Indonesian built from the facts only. Used when no LLM is configured or its text is rejected. */
export function templateReason(decision, snapshot, overrides = {}) {
  const p = { ...DEFAULT_PARAMS, ...overrides };
  const apy = formatPercent(snapshot.apyBps);
  const idlePct = formatPercent((snapshot.idle * BPS) / snapshot.total);
  if (decision.action === "deploy") {
    return `Kas menganggur ${formatAssets(snapshot.idle)} AUSD (${idlePct}% dari kota) tidak menghasilkan apa-apa, sementara sumber yield sedang ${apy}% per tahun. Usul: pindahkan ${formatAssets(decision.amount)} AUSD ke adapter yield; kas yang tersisa ${formatAssets(snapshot.idle - decision.amount)} AUSD tetap di atas batas aman ${formatPercent(p.idleBufferBps)}% untuk penarikan.`;
  }
  return `Yield sumber turun ke ${apy}% per tahun, di bawah batas ${formatPercent(p.minApyBps)}%. Usul: tarik ${formatAssets(decision.amount)} AUSD dari adapter kembali ke kas supaya tidak terkunci di yield yang hampir nol.`;
}

// ------------------------------------------------------------------------------------------------ the plan

/** The plan whose hash goes on-chain. The key order is part of the format; do not reorder. */
export function buildPlan({ city, decision, reason, snapshot, analyst, createdAt }) {
  return {
    v: 1,
    city: getAddress(city),
    from: getAddress(decision.from),
    to: getAddress(decision.to),
    amount: decision.amount.toString(),
    action: decision.action,
    reason,
    apyBps: Number(snapshot.apyBps),
    idle: snapshot.idle.toString(),
    total: snapshot.total.toString(),
    analyst: getAddress(analyst),
    createdAt,
  };
}
export const planHashOf = (plan) => keccak256(toBytes(JSON.stringify(plan)));
export const verifyPlan = (plan, hash) => typeof hash === "string" && planHashOf(plan).toLowerCase() === hash.toLowerCase();

// ------------------------------------------------------------------------------------------------ storage

/** Plans by `planHash`, kept in a JSON file so they survive restarts (put it on a volume). */
export function createPlanStore({ file } = {}) {
  /** @type {Map<string, {plan: object, planHash: string, proposalId: string | null, txHash: string | null}>} */
  const plans = new Map();
  /** @type {Map<string, number>} */
  const lastByCity = new Map();
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const [hash, entry] of Object.entries(saved.plans ?? {})) plans.set(hash, entry);
      for (const [city, at] of Object.entries(saved.last ?? {})) lastByCity.set(city, at);
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`proposal file ${file} could not be read (${e?.message}); starting empty`);
    }
  }
  const persist = () => {
    if (!file) return;
    if (plans.size > 2000) {
      const oldest = [...plans.entries()].sort((a, b) => a[1].plan.createdAt - b[1].plan.createdAt).slice(0, plans.size - 2000);
      for (const [hash] of oldest) plans.delete(hash);
    }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ plans: Object.fromEntries(plans), last: Object.fromEntries(lastByCity) }));
    renameSync(tmp, file);
  };
  return {
    put(planHash, plan) {
      plans.set(planHash, { plan, planHash, proposalId: null, txHash: null });
      persist();
    },
    attach(planHash, { proposalId, txHash }) {
      const entry = plans.get(planHash);
      if (entry) Object.assign(entry, { proposalId: proposalId?.toString() ?? null, txHash });
      persist();
    },
    drop(planHash) {
      plans.delete(planHash);
      persist();
    },
    markCity(city, at) {
      lastByCity.set(city.toLowerCase(), at);
      persist();
    },
    lastForCity: (city) => lastByCity.get(city.toLowerCase()) ?? 0,
    forCity: (city) =>
      [...plans.values()]
        .filter((e) => e.plan.city.toLowerCase() === city.toLowerCase())
        .sort((a, b) => b.plan.createdAt - a.plan.createdAt),
    size: () => plans.size,
  };
}

// ------------------------------------------------------------------------------------------------ the LLM reason

const REASON_SYSTEM = [
  'You are the Analyst ("Analis") on a city\'s AI staff in Nusastakes, a game where each city is an on-chain vault.',
  "You will receive facts about one proposed move of money. Write the reason the mayor will read: at most two plain sentences in Indonesian,",
  "friendly and concrete. Use only numbers that appear in the facts, and mention the amount to move exactly as given in `amountText`.",
  "Do not promise returns. Reply with the sentences only.",
].join(" ");

/** Where each provider is reached. Both speak the Anthropic Messages format. */
const PROVIDERS = {
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5" },
  // xKiro is a gateway compatible with the Anthropic and OpenAI formats; its model ids carry a vendor prefix and its
  // list (GET /v1/models) has no claude-sonnet-5-5 as of 13 Oct 2026, so anthropic/claude-sonnet-5 is the nearest.
  xkiro: { baseUrl: "https://api.xkiro.com/v1", model: "anthropic/claude-sonnet-5" },
};

/**
 * Asks one provider for the reason text. Returns null on any failure so the caller can try the next one or fall back to
 * the template.
 */
export async function askForReason({ provider = "anthropic", apiKey, model, baseUrl, fetchImpl = fetch, timeoutMs = 15_000 }, facts) {
  const known = PROVIDERS[provider];
  if (!apiKey || !known) return null;
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey };
  if (provider === "xkiro") headers.authorization = `Bearer ${apiKey}`; // xKiro documents both; send both
  try {
    const res = await fetchImpl(`${(baseUrl ?? known.baseUrl).replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers,
      // Sonnet 5.5 on Anthropic thinks by default and the thinking would eat the token budget; the answer is two sentences.
      body: JSON.stringify({
        model: model ?? known.model,
        max_tokens: 600,
        ...(provider === "anthropic" ? { thinking: { type: "between_tools" } } : {}),
        system: REASON_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(facts) }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const text = (body?.content ?? []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Tries the providers in order and returns the first usable text. */
export async function askForReasonAny(providers, facts) {
  for (const p of providers) {
    const text = await askForReason(p, facts);
    if (text) return text;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the bot

const shortReason = (e) => (e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 200);

export function createAnalyst({ publicClient, walletClient, config, store, llm = null, now = () => Date.now() }) {
  /** One provider config or a list of them, tried in order. */
  const providers = (Array.isArray(llm) ? llm : llm ? [llm] : []).filter((p) => p?.apiKey);
  const c = {
    guardian: config.guardian,
    factory: config.factory,
    feed: config.feed,
    sourceId: config.sourceId,
    asset: config.asset,
    params: config.params ?? {},
    cooldownSeconds: config.cooldownSeconds ?? 1800,
    proposalTtlSeconds: config.proposalTtlSeconds ?? 86_400,
    maxScanBack: config.maxScanBack ?? 200,
    gasMultiplierPercent: config.gasMultiplierPercent ?? 125n,
  };
  const account = walletClient.account;
  const mutex = new Mutex();
  const perCity = createRateLimiter({ windowMs: 30_000, max: 1, now });
  const perIp = createRateLimiter({ windowMs: 60_000, max: 10, now });
  const global = createRateLimiter({ windowMs: 60_000, max: 30, now });
  const nowSeconds = () => Math.floor(now() / 1000);

  async function feeCaps() {
    const block = await publicClient.getBlock();
    if (block.baseFeePerGas === undefined || block.baseFeePerGas === null) return {};
    const tip = publicClient.estimateMaxPriorityFeePerGas ? await publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n) : 0n;
    return { maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + tip, maxPriorityFeePerGas: tip };
  }

  async function pendingFor(city) {
    const count = await publicClient.readContract({ address: c.guardian, abi: guardianAbi, functionName: "proposalCount" });
    const floor = count > BigInt(c.maxScanBack) ? count - BigInt(c.maxScanBack) : 0n;
    for (let id = count - 1n; id >= floor; id--) {
      const p = await publicClient.readContract({ address: c.guardian, abi: guardianAbi, functionName: "proposals", args: [id] });
      if (p.city.toLowerCase() !== city.toLowerCase() || p.proposer.toLowerCase() !== account.address.toLowerCase()) continue;
      if (!p.approved && BigInt(nowSeconds()) <= p.createdAt + BigInt(c.proposalTtlSeconds)) return { id, ...p };
    }
    return null;
  }

  async function takeSnapshot(city) {
    const read = (address, abi, functionName, args) => publicClient.readContract({ address, abi, functionName, args });
    const [total, adapterList, maxShiftBps, idle, feed] = await Promise.all([
      read(city, vaultAbi, "totalAssets"),
      read(city, vaultAbi, "adapters"),
      read(city, vaultAbi, "maxShiftBps"),
      read(c.asset, tokenAbi, "balanceOf", [city]),
      read(c.feed, feedAbi, "latest", [c.sourceId]).catch(() => null),
    ]);
    const adapters = await Promise.all(
      adapterList.map(async (address) => ({
        address,
        assets: await read(address, adapterAbi, "totalAssets"),
        simulated: await read(address, adapterAbi, "isSimulated").catch(() => false),
      })),
    );
    const [apyBps, observedAt] = feed ?? [0, 0n];
    const known = feed !== null && observedAt > 0n;
    return {
      total,
      idle,
      maxShiftBps: BigInt(maxShiftBps),
      adapters,
      apyBps: known ? BigInt(apyBps) : null,
      apyAgeSeconds: known ? Math.max(0, nowSeconds() - Number(observedAt)) : null,
    };
  }

  /** Looks at one city and, if the rules say so and the mayor allowed it, files a proposal. */
  async function scanCity(rawCity) {
    const city = getAddress(rawCity);
    const granted = await publicClient.readContract({ address: c.guardian, abi: guardianAbi, functionName: "isActiveAgent", args: [city, account.address, ANALIS_ROLE] });
    if (!granted) return { city, status: "not-granted" };
    if (nowSeconds() - store.lastForCity(city) < c.cooldownSeconds) return { city, status: "cooldown" };
    const pending = await pendingFor(city);
    if (pending) return { city, status: "pending", proposalId: pending.id.toString(), planHash: pending.planHash };

    const snapshot = await takeSnapshot(city);
    const decision = decide(snapshot, c.params);
    if (decision.action === "none") return { city, status: "nothing-to-do", why: decision.why };

    const fallback = templateReason(decision, snapshot, c.params);
    const amountText = formatAssets(decision.amount);
    let reason = fallback;
    if (providers.length) {
      const text = await askForReasonAny(providers, {
        action: decision.action,
        amountText,
        idleText: formatAssets(snapshot.idle),
        totalText: formatAssets(snapshot.total),
        apyPercent: formatPercent(snapshot.apyBps),
        minApyPercent: formatPercent(BigInt((c.params.minApyBps ?? DEFAULT_PARAMS.minApyBps))),
        idleBufferPercent: formatPercent(c.params.idleBufferBps ?? DEFAULT_PARAMS.idleBufferBps),
      });
      // The numbers are the rules'; text that does not even mention the amount is not trusted.
      if (text && text.includes(amountText) && text.length <= 600) reason = text;
    }
    const plan = buildPlan({ city, decision, reason, snapshot, analyst: account.address, createdAt: nowSeconds() });
    const planHash = planHashOf(plan);
    const args = [city, plan.from, plan.to, decision.amount, planHash];

    let gas;
    try {
      gas = await publicClient.estimateContractGas({ address: c.guardian, abi: guardianAbi, functionName: "propose", args, account });
    } catch (e) {
      return { city, status: "would-fail", error: shortReason(e) };
    }
    gas = (gas * c.gasMultiplierPercent) / 100n;
    const fees = await feeCaps();
    if (fees.maxFeePerGas) {
      const balance = await publicClient.getBalance({ address: account.address });
      if (balance < gas * fees.maxFeePerGas) return { city, status: "analyst-out-of-gas" };
    }
    store.put(planHash, plan); // stored first so the UI can show the reason the moment the event appears
    try {
      const { hash, receipt } = await mutex.run(async () => {
        const h = await walletClient.writeContract({ address: c.guardian, abi: guardianAbi, functionName: "propose", args, gas, ...fees });
        return { hash: h, receipt: await publicClient.waitForTransactionReceipt({ hash: h }) };
      });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      const [created] = parseEventLogs({ abi: guardianAbi, eventName: "ProposalCreated", logs: receipt.logs });
      store.attach(planHash, { proposalId: created?.args.id ?? null, txHash: hash });
      store.markCity(city, nowSeconds());
      return { city, status: "proposed", proposalId: created ? created.args.id.toString() : null, planHash, txHash: hash, action: decision.action, amount: decision.amount.toString(), reason };
    } catch (e) {
      store.drop(planHash);
      return { city, status: "failed", error: shortReason(e) };
    }
  }

  async function scanAll() {
    const count = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "cityCount" });
    const results = [];
    for (let i = 0n; i < count; i++) {
      const city = await publicClient.readContract({ address: c.factory, abi: factoryAbi, functionName: "cityAt", args: [i] });
      try {
        results.push(await scanCity(city));
      } catch (e) {
        results.push({ city, status: "error", error: shortReason(e) });
      }
    }
    return results;
  }

  return {
    config: c,
    address: account.address,
    store,
    scanCity,
    scanAll,

    /** POST /analyst/run: a mayor (or anybody) asks for an immediate look at one city. Harmless: only the mayor approves. */
    async run(body, ctx = {}) {
      if (!body || typeof body !== "object" || typeof body.city !== "string" || !ADDRESS.test(body.city)) throw new HttpError(400, "city must be a 20-byte hex address");
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many analyst requests from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      if (!global.hit("all")) throw new HttpError(429, "the analyst is busy, try again shortly", { retryAfterSeconds: 10 });
      const key = body.city.toLowerCase();
      if (!perCity.hit(key)) throw new HttpError(429, "this city was just looked at, try again shortly", { retryAfterSeconds: Math.ceil(perCity.retryAfterMs(key) / 1000) });
      return scanCity(body.city);
    },

    /** GET /proposals/:city: the stored plans joined with their on-chain state. */
    async list(rawCity) {
      if (typeof rawCity !== "string" || !ADDRESS.test(rawCity)) throw new HttpError(400, "city must be a 20-byte hex address");
      const city = getAddress(rawCity);
      const out = [];
      for (const entry of store.forCity(city).slice(0, 20)) {
        let status = "unknown";
        if (entry.proposalId !== null) {
          try {
            const p = await publicClient.readContract({ address: c.guardian, abi: guardianAbi, functionName: "proposals", args: [BigInt(entry.proposalId)] });
            status = p.approved ? "approved" : BigInt(nowSeconds()) > p.createdAt + BigInt(c.proposalTtlSeconds) ? "expired" : "pending";
          } catch {
            status = "unknown";
          }
        }
        out.push({ proposalId: entry.proposalId, planHash: entry.planHash, txHash: entry.txHash, status, plan: entry.plan });
      }
      return { city, analyst: account.address, proposals: out };
    },

    /** GET /analyst */
    info() {
      return { enabled: true, address: account.address, role: ANALIS_ROLE, roleName: "ANALIS", guardian: c.guardian, llm: providers.length > 0, llmProviders: providers.map((p) => p.provider ?? "anthropic"), cooldownSeconds: c.cooldownSeconds };
    },
  };
}
