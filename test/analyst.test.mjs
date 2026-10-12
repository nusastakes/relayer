import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import {
  ANALIS_ROLE,
  ZERO_ADDRESS,
  askForReason,
  askForReasonAny,
  buildPlan,
  createAnalyst,
  createPlanStore,
  decide,
  formatAssets,
  guardianAbi,
  planHashOf,
  templateReason,
  verifyPlan,
} from "../src/analyst.mjs";
import { createHttpServer } from "../src/server.mjs";

const ADDR = (n) => "0x" + n.toString(16).padStart(40, "0");
const CITY = ADDR(0xc1710);
const MIRROR = ADDR(0xa1);
const OTHER = ADDR(0xa2);
const GUARDIAN = ADDR(0x9a);
const FACTORY = ADDR(0xfac7);
const FEED = ADDR(0xfeed);
const TOKEN = ADDR(0x70);
const ANALYST = ADDR(0xa11a);
const SOURCE = "0x" + "71".repeat(32);
const AUSD = (n) => BigInt(Math.round(n * 1e6));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const snap = (over = {}) => ({
  total: AUSD(1000),
  idle: AUSD(1000),
  maxShiftBps: 5000n,
  apyBps: 128n,
  apyAgeSeconds: 3600,
  adapters: [{ address: MIRROR, assets: 0n, simulated: true }],
  ...over,
});

// ------------------------------------------------------------------------------------------------ rules

test("formatAssets: two decimals, exact", () => {
  assert.equal(formatAssets(AUSD(600)), "600.00");
  assert.equal(formatAssets(1_234_567n), "1.23");
  assert.equal(formatAssets(5_000n), "0.00");
  assert.equal(formatAssets(0n), "0.00");
});

test("decide: idle cash above the 20% buffer is deployed, capped by what the vault lets one call move", () => {
  const d = decide(snap());
  assert.equal(d.action, "deploy");
  assert.equal(d.from, ZERO_ADDRESS);
  assert.equal(d.to, MIRROR);
  // 1000 total, 20% buffer -> 800 deployable, but 50% x 95% = 475 per call
  assert.equal(d.amount, AUSD(475));
  const small = decide(snap({ total: AUSD(1000), idle: AUSD(900), adapters: [{ address: MIRROR, assets: AUSD(100), simulated: true }], maxShiftBps: 10_000n }));
  assert.equal(small.amount, AUSD(700), "900 idle - 200 buffer");
});

test("decide: does nothing when idle is already near the buffer, when the move is dust, or when the city is empty", () => {
  assert.equal(decide(snap({ idle: AUSD(150), adapters: [{ address: MIRROR, assets: AUSD(850), simulated: true }] })).action, "none");
  assert.equal(decide(snap({ total: AUSD(1.1), idle: AUSD(1.1) })).action, "none", "below minMove");
  assert.equal(decide(snap({ total: 0n, idle: 0n })).action, "none");
});

test("decide: never judges data it cannot trust", () => {
  assert.match(decide(snap({ apyBps: null, apyAgeSeconds: null })).why, /missing/);
  assert.match(decide(snap({ apyAgeSeconds: 8 * 24 * 3600 })).why, /stale/);
  assert.match(decide(snap({ adapters: [{ address: MIRROR, assets: 0n, simulated: false }] })).why, /no adapter with a known yield/);
});

test("decide: yield below the minimum pulls money back, but only if some is invested", () => {
  const invested = snap({ idle: AUSD(100), apyBps: 10n, adapters: [{ address: MIRROR, assets: AUSD(900), simulated: true }] });
  const d = decide(invested);
  assert.equal(d.action, "pullback");
  assert.equal(d.from, MIRROR);
  assert.equal(d.to, ZERO_ADDRESS);
  assert.equal(d.amount, AUSD(475));
  assert.equal(decide(snap({ apyBps: 10n })).action, "none", "low yield but nothing invested");
});

test("decide: spreads new money to the adapter that holds the least", () => {
  const d = decide(snap({ adapters: [{ address: MIRROR, assets: AUSD(300), simulated: true }, { address: OTHER, assets: AUSD(50), simulated: true }], idle: AUSD(650), total: AUSD(1000) }));
  assert.equal(d.to, OTHER);
});

test("templateReason: Indonesian, states the amount and the yield from the facts", () => {
  const s = snap();
  const d = decide(s);
  const text = templateReason(d, s);
  assert.match(text, /475\.00 AUSD/);
  assert.match(text, /1\.28%/);
  assert.match(text, /1000\.00 AUSD/);
  assert.match(text, /kas yang tersisa 525\.00 AUSD tetap di atas batas aman 20\.00%/);
  const pull = snap({ idle: AUSD(100), apyBps: 10n, adapters: [{ address: MIRROR, assets: AUSD(900), simulated: true }] });
  assert.match(templateReason(decide(pull), pull), /tarik 475\.00 AUSD/);
});

// ------------------------------------------------------------------------------------------------ plan and hash

test("plan hash: commits to the reason, so an edited reason no longer verifies", () => {
  const s = snap();
  const d = decide(s);
  const plan = buildPlan({ city: CITY, decision: d, reason: templateReason(d, s), snapshot: s, analyst: ANALYST, createdAt: 1_700_000_000 });
  const hash = planHashOf(plan);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(verifyPlan(plan, hash), true);
  assert.equal(verifyPlan({ ...plan, reason: "lain" }, hash), false);
  assert.equal(verifyPlan({ ...plan, amount: "1" }, hash), false);
  assert.equal(planHashOf(JSON.parse(JSON.stringify(plan))), hash, "survives a JSON round trip");
});

test("plan store: survives a restart and forgets dropped plans", () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  try {
    const file = join(dir, "n", "p.json");
    const store = createPlanStore({ file });
    const plan = { city: CITY, createdAt: 5 };
    store.put("0xaa", plan);
    store.attach("0xaa", { proposalId: 7n, txHash: "0xbb" });
    store.markCity(CITY, 99);
    const again = createPlanStore({ file });
    assert.equal(again.forCity(CITY)[0].proposalId, "7");
    assert.equal(again.lastForCity(CITY), 99);
    again.drop("0xaa");
    assert.equal(createPlanStore({ file }).forCity(CITY).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ LLM reason

test("askForReason: sends the key only in the header, turns thinking off, returns the text", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Pindahkan 475.00 AUSD." }] }) };
  };
  const text = await askForReason({ apiKey: "sk-secret", fetchImpl }, { amountText: "475.00" });
  assert.equal(text, "Pindahkan 475.00 AUSD.");
  assert.equal(seen.init.headers["x-api-key"], "sk-secret");
  assert.equal(JSON.parse(seen.init.body).thinking.type, "between_tools");
  assert.equal(seen.init.body.includes("sk-secret"), false);
});

test("askForReason: xKiro goes to its gateway with its own model id, both auth headers and no thinking field", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "ok 475.00" }] }) };
  };
  assert.equal(await askForReason({ provider: "xkiro", apiKey: "xk-secret", fetchImpl }, {}), "ok 475.00");
  assert.equal(seen.url, "https://api.xkiro.com/v1/messages");
  assert.equal(seen.init.headers.authorization, "Bearer xk-secret");
  assert.equal(seen.init.headers["x-api-key"], "xk-secret");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "anthropic/claude-sonnet-5");
  assert.equal("thinking" in body, false);
  assert.equal(await askForReason({ provider: "nope", apiKey: "k", fetchImpl }, {}), null, "unknown provider");
});

test("askForReasonAny: falls through to the next provider when the first fails", async () => {
  const calls = [];
  const down = { provider: "anthropic", apiKey: "a", fetchImpl: async (url) => { calls.push(url); return { ok: false }; } };
  const up = { provider: "xkiro", apiKey: "x", fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ content: [{ type: "text", text: "dari xkiro" }] }) }; } };
  assert.equal(await askForReasonAny([down, up], {}), "dari xkiro");
  assert.deepEqual(calls, ["https://api.anthropic.com/v1/messages", "https://api.xkiro.com/v1/messages"]);
  assert.equal(await askForReasonAny([down], {}), null);
  assert.equal(await askForReasonAny([], {}), null);
});

test("askForReason: any failure or a missing key means null, never a throw", async () => {
  assert.equal(await askForReason({ apiKey: "" }, {}), null);
  assert.equal(await askForReason({ apiKey: "k", fetchImpl: async () => ({ ok: false }) }, {}), null);
  assert.equal(await askForReason({ apiKey: "k", fetchImpl: async () => { throw new Error("down"); } }, {}), null);
});

// ------------------------------------------------------------------------------------------------ the bot

function proposalLog(id) {
  const topics = encodeEventTopics({ abi: guardianAbi, eventName: "ProposalCreated", args: { id, city: CITY, proposer: ANALYST } });
  const data = encodeAbiParameters(parseAbi(["function f(address from, address to, uint256 amount, bytes32 planHash)"])[0].inputs, [ZERO_ADDRESS, MIRROR, 1n, "0x" + "00".repeat(32)]);
  return { address: GUARDIAN, topics, data, blockNumber: 1n, transactionHash: "0x" + "ab".repeat(32), transactionIndex: 0, blockHash: "0x" + "cd".repeat(32), logIndex: 0, removed: false };
}

function fakes({ granted = true, snapshot = snap(), proposals = [], estimateError = null, writeError = null, balance = 10n ** 19n, status = "success" } = {}) {
  const calls = { written: [], estimates: [] };
  const publicClient = {
    getBlock: async () => ({ baseFeePerGas: 100_000_000_000n }),
    estimateMaxPriorityFeePerGas: async () => 1_000_000_000n,
    getBalance: async () => balance,
    readContract: async ({ address, functionName, args }) => {
      switch (functionName) {
        case "isActiveAgent":
          assert.equal(args[2], ANALIS_ROLE);
          return granted;
        case "proposalCount":
          return BigInt(proposals.length);
        case "proposals":
          return proposals[Number(args[0])];
        case "totalAssets":
          return same(address, CITY) ? snapshot.total : snapshot.adapters.find((a) => same(a.address, address)).assets;
        case "adapters":
          return snapshot.adapters.map((a) => a.address);
        case "maxShiftBps":
          return Number(snapshot.maxShiftBps);
        case "balanceOf":
          return snapshot.idle;
        case "latest":
          return snapshot.apyBps === null ? [0, 0n, 0n] : [Number(snapshot.apyBps), BigInt(Math.floor(NOW / 1000) - snapshot.apyAgeSeconds), 0n];
        case "isSimulated":
          return snapshot.adapters.find((a) => same(a.address, address)).simulated;
        case "cityCount":
          return 2n;
        case "cityAt":
          return args[0] === 0n ? CITY : ADDR(0xc2);
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    estimateContractGas: async (req) => {
      calls.estimates.push(req);
      if (estimateError) throw new Error(estimateError);
      return 150_000n;
    },
    waitForTransactionReceipt: async () => ({ status, gasUsed: 100_000n, logs: [proposalLog(5n)] }),
  };
  const walletClient = {
    account: { address: ANALYST },
    writeContract: async (req) => {
      if (writeError) throw new Error(writeError);
      calls.written.push(req);
      return "0x" + "ee".repeat(32);
    },
  };
  return { publicClient, walletClient, calls };
}

const NOW = 1_800_000_000_000;
const botWith = (opts = {}, extra = {}) => {
  const f = fakes(opts);
  const store = createPlanStore();
  const analyst = createAnalyst({ ...f, store, now: () => NOW, config: { guardian: GUARDIAN, factory: FACTORY, feed: FEED, sourceId: SOURCE, asset: TOKEN, ...extra.config }, llm: extra.llm ?? null });
  return { analyst, store, ...f };
};

test("scan: proposes the deploy with the rules' numbers and stores the reason before the event is seen", async () => {
  const { analyst, store, calls } = botWith();
  const out = await analyst.scanCity(CITY);
  assert.equal(out.status, "proposed");
  assert.equal(out.proposalId, "5");
  assert.equal(calls.written.length, 1);
  const tx = calls.written[0];
  assert.equal(tx.functionName, "propose");
  const [city, from, to, amount, planHash] = tx.args;
  assert.ok(same(city, CITY));
  assert.equal(from, ZERO_ADDRESS);
  assert.ok(same(to, MIRROR));
  assert.equal(amount, AUSD(475));
  assert.equal(tx.gas, 187_500n, "estimate 150k x 125%");
  const stored = store.forCity(CITY)[0];
  assert.equal(stored.planHash, planHash);
  assert.equal(stored.proposalId, "5");
  assert.equal(verifyPlan(stored.plan, planHash), true, "the stored plan is the one the proposal committed to");
  assert.match(stored.plan.reason, /475\.00 AUSD/);
});

test("scan: a city whose mayor did not grant the role is left alone", async () => {
  const { analyst, calls } = botWith({ granted: false });
  assert.equal((await analyst.scanCity(CITY)).status, "not-granted");
  assert.equal(calls.written.length, 0);
});

test("scan: waits while its own proposal is still pending, and ignores approved or expired ones", async () => {
  const mk = (over) => ({ city: CITY, from: ZERO_ADDRESS, to: MIRROR, amount: 1n, planHash: "0x" + "11".repeat(32), proposer: ANALYST, createdAt: BigInt(NOW / 1000 - 3600), approved: false, ...over });
  assert.equal((await botWith({ proposals: [mk({})] }).analyst.scanCity(CITY)).status, "pending");
  assert.equal((await botWith({ proposals: [mk({ approved: true })] }).analyst.scanCity(CITY)).status, "proposed");
  assert.equal((await botWith({ proposals: [mk({ createdAt: BigInt(NOW / 1000 - 90_000) })] }).analyst.scanCity(CITY)).status, "proposed");
  assert.equal((await botWith({ proposals: [mk({ proposer: ADDR(0xbad) })] }).analyst.scanCity(CITY)).status, "proposed", "someone else's proposal is not ours");
});

test("scan: cools down after proposing, so approved plans are not re-proposed in a loop", async () => {
  const { analyst, calls } = botWith();
  assert.equal((await analyst.scanCity(CITY)).status, "proposed");
  assert.equal((await analyst.scanCity(CITY)).status, "cooldown");
  assert.equal(calls.written.length, 1);
});

test("scan: nothing to do when the rules say so", async () => {
  const { analyst, calls } = botWith({ snapshot: snap({ apyBps: null, apyAgeSeconds: null }) });
  const out = await analyst.scanCity(CITY);
  assert.equal(out.status, "nothing-to-do");
  assert.match(out.why, /missing/);
  assert.equal(calls.written.length, 0);
});

test("scan: a transaction that would fail, one that reverts, or an empty wallet leaves no stored plan behind", async () => {
  for (const [opts, want] of [
    [{ estimateError: "NotActiveAgent" }, "would-fail"],
    [{ writeError: "nonce too low" }, "failed"],
    [{ status: "reverted" }, "failed"],
    [{ balance: 0n }, "analyst-out-of-gas"],
  ]) {
    const { analyst, store } = botWith(opts);
    assert.equal((await analyst.scanCity(CITY)).status, want, Object.keys(opts).join());
    assert.equal(store.size(), 0);
  }
});

test("scan: LLM text is used only if it mentions the amount; otherwise the template stays", async () => {
  const llm = (text) => ({ apiKey: "k", fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text }] }) }) });
  const good = botWith({}, { llm: llm("Kas 1000.00 AUSD menganggur; pindahkan 475.00 AUSD ke adapter.") });
  assert.match((await good.analyst.scanCity(CITY)).reason, /^Kas 1000\.00 AUSD menganggur/);
  const bad = botWith({}, { llm: llm("Pindahkan 9999 AUSD sekarang juga!") });
  assert.match((await bad.analyst.scanCity(CITY)).reason, /Kas menganggur 1000\.00 AUSD/);
});

test("scanAll: visits every city and keeps going when one fails", async () => {
  const { analyst, publicClient } = botWith();
  const original = publicClient.readContract;
  publicClient.readContract = async (req) => {
    if (req.functionName === "isActiveAgent" && !same(req.args[0], CITY)) throw new Error("rpc down");
    return original(req);
  };
  const results = await analyst.scanAll();
  assert.deepEqual(results.map((r) => r.status), ["proposed", "error"]);
});

test("list: joins stored plans with on-chain state; run: validates and rate limits", async () => {
  const { analyst, publicClient } = botWith();
  await analyst.scanCity(CITY);
  const original = publicClient.readContract;
  let approved = false;
  publicClient.readContract = async (req) =>
    req.functionName === "proposals" ? { city: CITY, createdAt: BigInt(NOW / 1000), approved } : original(req);
  const pending = await analyst.list(CITY);
  assert.equal(pending.proposals[0].status, "pending");
  assert.ok(same(pending.analyst, ANALYST));
  approved = true;
  assert.equal((await analyst.list(CITY)).proposals[0].status, "approved");
  await assert.rejects(analyst.list("0x1"), (e) => e.status === 400);

  await assert.rejects(analyst.run({ city: "nope" }), (e) => e.status === 400);
  const first = await analyst.run({ city: CITY });
  assert.ok(first.status);
  await assert.rejects(analyst.run({ city: CITY }), (e) => e.status === 429 && e.extra.retryAfterSeconds > 0);
  assert.deepEqual(Object.keys(analyst.info()).sort(), ["address", "cooldownSeconds", "enabled", "guardian", "llm", "llmProviders", "role", "roleName"]);
});

test("analyst over HTTP: info, proposals, run; and the routes are absent without an analyst", async () => {
  const { analyst } = botWith();
  const serve = async (relayer) => {
    const server = createHttpServer(relayer, { allowedOrigins: ["http://localhost:3000"] });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const { server, base } = await serve({ analyst, health: async () => ({ ok: true }) });
  try {
    const info = await (await fetch(`${base}/analyst`)).json();
    assert.ok(same(info.address, ANALYST));
    const run = await fetch(`${base}/analyst/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ city: CITY }) });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).status, "proposed");
    const list = await fetch(`${base}/proposals/${CITY}`);
    assert.equal(list.status, 200);
    assert.ok(same((await list.json()).city, CITY));
    assert.equal((await fetch(`${base}/proposals/nope`)).status, 400);
  } finally {
    server.close();
  }
  const off = await serve({ health: async () => ({ ok: true }) });
  try {
    assert.equal((await fetch(`${off.base}/analyst`)).status, 404);
    assert.equal((await fetch(`${off.base}/proposals/${CITY}`)).status, 404);
  } finally {
    off.server.close();
  }
});
