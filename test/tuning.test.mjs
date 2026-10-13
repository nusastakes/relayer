import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_TUNING, decodeTuning, effectiveApy, encodeTuning, knobsFor, loopRule, ownSourceId, rangeEfficiency } from "../src/tuning.mjs";
import { cloneImplementation, needsWrite } from "../src/tuned.mjs";
import { PRESETS, RULES_DOMAIN, RULES_PRIMARY_TYPE, RULES_TYPES, createAutopilot, planActions, validateRules } from "../src/autopilot.mjs";
import { SEEDS } from "../src/catalog.mjs";

// DefiLlama readings of 14 Oct 2026 around 01.48 WIB (vault TC67.10).
const AAVE = { pool: { apy: 5.84244, apyBase: 3.37387, apyReward: 2.46857 }, lend: { apyBaseBorrow: 4.84042, ltv: 0, borrowable: true } };
const NEVERLAND = { pool: { apy: 9.12343, apyBase: 3.31569, apyReward: 5.80774 }, lend: { apyBaseBorrow: 5.61943, ltv: 0.85, borrowable: true } };
const UNI = { pool: { apy: 105.24767, apyBase: 105.24767, apyReward: null }, lend: null, monPriceUsd: 0.0245 };

test("tuning: encode/decode round trip, defaults for empty and unreadable bytes", () => {
  const t = { loopX100: 250, takeRewards: false, rangeBps: 1000, centerPriceE8: 2_450_000n };
  const d = decodeTuning(encodeTuning(t));
  assert.equal(d.version, 1);
  assert.equal(d.loopX100, 250);
  assert.equal(d.takeRewards, false);
  assert.equal(d.rangeBps, 1000);
  assert.equal(d.centerPriceE8, 2_450_000n);
  assert.deepEqual(decodeTuning("0x"), { ...DEFAULT_TUNING });
  assert.equal(decodeTuning("0x1234").unreadable, true);
});

test("tuning: own feed key matches TunedMirrorAdapter (keccak256(abi.encode('nusastakes.tuned', adapter)))", () => {
  // Computed with `cast keccak $(cast abi-encode "f(string,address)" nusastakes.tuned 0x1111…)`.
  assert.equal(ownSourceId("0x1111111111111111111111111111111111111111"), "0x5e59276e8e668200e83f2b84723435d928f47362b0d070801384d91cf6017c0d");
});

test("tuning: rewards are taken with a 10% haircut, or left out", () => {
  const on = effectiveApy("aave-ausd", { takeRewards: true }, AAVE);
  const off = effectiveApy("aave-ausd", { takeRewards: false }, AAVE);
  assert.equal(on.effectiveApyBps, Math.round((3.37387 + 2.46857 * 0.9) * 100));
  assert.equal(off.effectiveApyBps, 337);
});

test("tuning: a loop is refused where the protocol does not take the asset as collateral", () => {
  const r = effectiveApy("aave-ausd", { loopX100: 200 }, AAVE);
  assert.equal(r.breakdown.loop.allowed, false);
  assert.match(r.notes.join(" "), /LTV 0/);
  assert.equal(r.effectiveApyBps, effectiveApy("aave-ausd", {}, AAVE).effectiveApyBps);
  assert.equal(loopRule(AAVE.lend).allowed, false);
});

test("tuning: a loop on Neverland follows L x supply - (L - 1) x borrow, capped at 3x", () => {
  const supply = 3.31569 + 5.80774 * 0.9;
  const two = effectiveApy("neverland-ausd", { loopX100: 200 }, NEVERLAND);
  assert.equal(two.effectiveApyBps, Math.round((2 * supply - 5.61943) * 100));
  const many = effectiveApy("neverland-ausd", { loopX100: 900 }, NEVERLAND);
  assert.equal(many.breakdown.loop.appliedX100, 300);
  assert.equal(loopRule(NEVERLAND.lend).maxX100, 300);
});

test("tuning: a losing loop is written as 0 and reported negative", () => {
  const r = effectiveApy("neverland-ausd", { loopX100: 300, takeRewards: false }, NEVERLAND);
  assert.ok(r.uncappedApyBps < 0);
  assert.equal(r.effectiveApyBps, 0);
});

test("tuning: Uniswap range concentrates fees and earns nothing out of range; the feed caps at 50%", () => {
  assert.equal(rangeEfficiency(0), 1);
  const ref = effectiveApy("uniswap-wmon-usdc", { rangeBps: 5000, centerPriceE8: 2_450_000n }, UNI);
  assert.equal(ref.uncappedApyBps, Math.round(105.24767 * 100));
  assert.equal(ref.effectiveApyBps, 5000);
  const full = effectiveApy("uniswap-wmon-usdc", { rangeBps: 0 }, UNI);
  assert.ok(full.uncappedApyBps < ref.uncappedApyBps);
  const out = effectiveApy("uniswap-wmon-usdc", { rangeBps: 500, centerPriceE8: 3_000_000n }, UNI); // centre 0.03, price 0.0245
  assert.equal(out.inRange, false);
  assert.equal(out.effectiveApyBps, 0);
});

test("tuning: knobs only where the protocol gives depositors something to tune", () => {
  const aave = knobsFor("aave-ausd", "bank", AAVE);
  assert.ok(aave.rewards);
  assert.equal(aave.loop.allowed, false);
  assert.equal(knobsFor("shmonad", "staking", { pool: { apy: 14.4, apyBase: 14.4, apyReward: null } }), null);
  assert.deepEqual(knobsFor("uniswap-wmon-usdc", "market", UNI).range.options, [500, 1000, 2500, 5000, 0]);
});

test("tuned keeper: clone bytecode gives the implementation; write rule", () => {
  const impl = "b38aae47e1766069738223bff24e0184fd057b53";
  assert.equal(cloneImplementation(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`), `0x${impl}`);
  assert.equal(cloneImplementation("0x6080"), null);
  assert.equal(needsWrite({ effectiveBps: 500, onFeed: null, tuningChanged: false, nowSec: 10 }), true);
  assert.equal(needsWrite({ effectiveBps: 500, onFeed: { apyBps: 502, updatedAt: 5 }, tuningChanged: false, nowSec: 10 }), false);
  assert.equal(needsWrite({ effectiveBps: 500, onFeed: { apyBps: 502, updatedAt: 5 }, tuningChanged: true, nowSec: 10 }), true);
  assert.equal(needsWrite({ effectiveBps: 500, onFeed: { apyBps: 510, updatedAt: 5 }, tuningChanged: false, nowSec: 10 }), true);
});

// ---------------------------------------------------------------- rules

const ids = new Set(SEEDS.map((s) => s.id));
const A = (n) => BigInt(Math.round(n * 1e6));
const state = (over = {}) => ({
  total: A(1000),
  cash: A(100),
  services: [
    { serviceId: "aave-ausd", adapter: "0xa", assets: A(500), apyBps: 560, tuned: true, tuning: { ...DEFAULT_TUNING } },
    { serviceId: "neverland-ausd", adapter: "0xb", assets: A(400), apyBps: 830, tuned: true, tuning: { ...DEFAULT_TUNING }, loopSpreadBps: 270, borrowApyBps: 562 },
    { serviceId: "uniswap-wmon-usdc", adapter: "0xc", assets: 0n, apyBps: 0, tuned: true, tuning: { ...DEFAULT_TUNING, rangeBps: 500, centerPriceE8: 3_000_000n }, outOfRange: true },
  ],
  limits: { perCall: A(500), budgetLeft: A(200) },
  monPriceE8: 2_450_000n,
  ...over,
});

test("rules: every preset validates", () => {
  for (const p of PRESETS) assert.equal(validateRules(p.rules, ids).length, p.rules.length);
});

test("rules: bad rules are refused with a reason", () => {
  assert.throws(() => validateRules([{ id: "x", when: { metric: "apy", op: "<", value: 1 }, then: { action: "move", from: "cash", to: "best", pct: 10 } }], ids), /when.service/);
  assert.throws(() => validateRules([{ id: "x", when: { metric: "cashPct", op: "<", value: 1 }, then: { action: "move", from: "cash", to: "cash", pct: 10 } }], ids), /same/);
  assert.throws(() => validateRules([{ id: "x", when: { metric: "cashPct", op: "=", value: 1 }, then: { action: "move", from: "cash", to: "best", pct: 10 } }], ids), /op/);
  assert.throws(() => validateRules([{ id: "x", when: { metric: "cashPct", op: "<", value: 1 }, then: { action: "tune", service: "aave-ausd", set: { loopX100: 900 } } }], ids), /loopX100/);
  assert.throws(() => validateRules([{ id: "x", when: { metric: "cashPct", op: "<", value: 1 }, then: { action: "move", from: "nope", to: "best", pct: 10 } }], ids), /move needs/);
});

test("rules: chase-apy moves a quarter of the worst to the best, within the hourly budget", () => {
  const rules = validateRules(PRESETS.find((p) => p.id === "chase-apy").rules, ids);
  const [a] = planActions(rules, state(), { nowSec: 1_000_000 });
  assert.equal(a.kind, "move");
  assert.equal(a.fromService, "aave-ausd");
  assert.equal(a.toService, "neverland-ausd");
  assert.equal(a.amount, A(125)); // 25% of 500, under perCall 500 and budget 200
  const [b] = planActions(rules, state({ limits: { perCall: A(500), budgetLeft: A(50) } }), { nowSec: 1_000_000 });
  assert.equal(b.amount, A(50));
});

test("rules: keep-cash refills cash from the largest service; cooldown and the action cap hold", () => {
  const rules = validateRules(PRESETS.find((p) => p.id === "keep-cash-20").rules, ids);
  const [a] = planActions(rules, state(), { nowSec: 1_000_000 });
  assert.equal(a.toService, "cash");
  assert.equal(a.fromService, "aave-ausd");
  assert.equal(a.amount, A(50));
  assert.equal(planActions(rules, state(), { nowSec: 1_000_000, lastFired: new Map([["cash-low", 1_000_000 - 60]]) }).length, 0);
  const all = validateRules(PRESETS.flatMap((p) => p.rules), ids);
  assert.ok(planActions(all, state(), { nowSec: 1_000_000 }).length <= 2);
});

test("rules: recenter re-centres an out-of-range Uniswap position on the current price", () => {
  const rules = validateRules(PRESETS.find((p) => p.id === "recenter").rules, ids);
  const [a] = planActions(rules, state(), { nowSec: 1_000_000 });
  assert.equal(a.kind, "tune");
  assert.equal(a.tuning.centerPriceE8, 2_450_000n);
  assert.equal(a.tuning.rangeBps, 500);
});

test("rules: unwind-loop fires only when borrowing costs more than the deposit earns", () => {
  const rules = validateRules(PRESETS.find((p) => p.id === "unwind-loop").rules, ids);
  assert.equal(planActions(rules, state(), { nowSec: 1_000_000 }).length, 0);
  const s = state();
  s.services[1] = { ...s.services[1], loopSpreadBps: -20, tuning: { ...DEFAULT_TUNING, loopX100: 250 } };
  const [a] = planActions(rules, s, { nowSec: 1_000_000 });
  assert.equal(a.tuning.loopX100, 100);
});

test("rules: brake moves half of a collapsing service to cash", () => {
  const rules = validateRules(PRESETS.find((p) => p.id === "brake").rules, ids);
  const s = state();
  s.services[0] = { ...s.services[0], apyBps: 120 };
  const [a] = planActions(rules, s, { nowSec: 1_000_000 });
  assert.equal(a.fromService, "aave-ausd");
  assert.equal(a.toService, "cash");
  assert.equal(a.amount, A(200)); // half of 500 is 250, the hourly budget leaves 200
});

test("rules: only the mayor's EIP-712 signature over the exact JSON is accepted, and the nonce must grow", async () => {
  const mayor = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const vault = "0x49c80000000000000000000000000000000c6265";
  const publicClient = {
    readContract: async ({ functionName }) => (functionName === "isCity" ? true : functionName === "mayor" ? mayor.address : null),
  };
  const ap = createAutopilot({ publicClient, factory: "0x0000000000000000000000000000000000000001", tuned: null, market: null, seeds: SEEDS, sourceIdOfSeed: () => "0x00" });
  const rulesJson = JSON.stringify(PRESETS[0].rules);
  const sign = (acct, nonce, json = rulesJson) => acct.signTypedData({ domain: RULES_DOMAIN, types: RULES_TYPES, primaryType: RULES_PRIMARY_TYPE, message: { vault, rulesHash: keccak256(toBytes(json)), nonce } });
  await assert.rejects(ap.set(vault, { vault, rulesJson, nonce: 1, signature: await sign(other, 1n) }), /mayor/);
  const ok = await ap.set(vault, { vault, rulesJson, nonce: 1, signature: await sign(mayor, 1n) });
  assert.equal(ok.rules.length, 1);
  await assert.rejects(ap.set(vault, { vault, rulesJson, nonce: 1, signature: await sign(mayor, 1n) }), /nonce/);
  // A signature over different JSON does not cover these rules.
  await assert.rejects(ap.set(vault, { vault, rulesJson, nonce: 2, signature: await sign(mayor, 2n, "[]") }), /mayor/);
});
