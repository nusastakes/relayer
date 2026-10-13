import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScore, level, yieldFromSnapshots } from "../src/score.mjs";

const A = (n) => BigInt(Math.round(n * 1e6));

test("an empty city scores zero and has no crowd", () => {
  const r = computeScore({ tvl: 0n, income7d: 0n, outsideTraffic7d: 0n });
  assert.equal(r.score, 0);
  assert.equal(r.stage, "empty");
  assert.equal(r.crowd, 0);
});

test("levels are logarithmic and capped at the reference", () => {
  assert.equal(level(0n, 100e6), 0);
  assert.equal(level(A(100), 100e6), 1);
  assert.equal(level(A(1_000), 100e6), 1);
  assert.ok(level(A(10), 100e6) > 0.4 && level(A(10), 100e6) < 0.6);
});

test("more kinds of service score higher for the same economy", () => {
  const base = { tvl: A(5_000), income7d: A(20), outsideTraffic7d: A(2_000) };
  const one = computeScore({ ...base, adapters: [{ category: "bank", assets: A(4_000) }] });
  const many = computeScore({
    ...base,
    adapters: [{ category: "bank", assets: A(2_000) }, { category: "staking", assets: A(1_000) }, { category: "market", assets: A(1_000) }],
    services: { 1: { on: true } },
    staffActive: true,
  });
  assert.ok(many.score > one.score, `${many.score} > ${one.score}`);
  assert.deepEqual(many.variety.kinds.sort(), ["bank", "launchpad", "market", "staff", "staking"]);
  assert.equal(many.activeServices, 5);
});

test("an adapter without funds is not an active service", () => {
  const r = computeScore({ tvl: A(100), income7d: 0n, outsideTraffic7d: 0n, adapters: [{ category: "bank", assets: 0n }] });
  assert.equal(r.activeServices, 0);
});

test("a busy but poor city is not drawn as crowded", () => {
  const r = computeScore({ tvl: A(10), income7d: 0n, outsideTraffic7d: A(50_000) });
  assert.equal(r.levels.traffic, 1);
  assert.ok(r.crowd <= r.levels.wealth);
});

test("score stays within 0..100", () => {
  const r = computeScore({
    tvl: A(10_000_000), income7d: A(1_000_000), outsideTraffic7d: A(10_000_000),
    adapters: ["bank", "vault", "staking", "market"].map((c) => ({ category: c, assets: A(1) })),
    services: { 1: { on: true } }, staffActive: true,
  });
  assert.equal(r.score, 100);
  assert.equal(r.stage, "metropolis");
});

test("yield from snapshots uses the share price rise over the window", () => {
  const now = 1_000_000;
  const snaps = [
    { ts: now - 8 * 86_400, pps: "1000000", tvl: "1000000000" },
    { ts: now - 7 * 86_400 + 60, pps: "1000000", tvl: "1000000000" },
    { ts: now, pps: "1010000", tvl: "1010000000" },
  ];
  assert.equal(yieldFromSnapshots(snaps, now, 7), 10_000_000n);
  assert.equal(yieldFromSnapshots([], now, 7), 0n);
});
