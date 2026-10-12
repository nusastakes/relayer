import test from "node:test";
import assert from "node:assert/strict";
import { MAX_APY_BPS, YEAR_SECONDS, apyFractionToBps, computeApyBps, findBlockAtOrBefore, shouldWrite } from "../src/apy.mjs";

test("a price that rises 1% in a year is 100 bps", () => {
  assert.equal(computeApyBps(1_000_000n, 1_010_000n, YEAR_SECONDS), 100n);
});

test("annualises shorter windows: 0.01% in 3 days is about 1.22%", () => {
  const dt = 3n * 86400n;
  const bps = computeApyBps(10n ** 18n, 10n ** 18n + 10n ** 14n, dt);
  // 0.0001 * 365 / 3 = 0.012167 -> 122 bps
  assert.equal(bps, 122n);
});

test("rounds half up", () => {
  // exactly 0.5 bps -> 1
  assert.equal(computeApyBps(20_000n, 20_001n, YEAR_SECONDS), 1n);
  // just under 0.5 bps -> 0
  assert.equal(computeApyBps(20_001n, 20_002n, YEAR_SECONDS), 0n);
});

test("a flat or falling price is 0, never negative", () => {
  assert.equal(computeApyBps(100n, 100n, 86400n), 0n);
  assert.equal(computeApyBps(100n, 90n, 86400n), 0n);
});

test("clamps to the feed ceiling", () => {
  assert.equal(computeApyBps(100n, 1_000n, 86400n), MAX_APY_BPS);
  assert.equal(MAX_APY_BPS, 5000n);
});

test("rejects nonsense input", () => {
  assert.throws(() => computeApyBps(0n, 1n, 1n));
  assert.throws(() => computeApyBps(1n, 2n, 0n));
});

test("netApy fraction to bps", () => {
  assert.equal(apyFractionToBps(0.01503003354538297), 150n);
  assert.equal(apyFractionToBps(0), 0n);
  assert.equal(apyFractionToBps(-0.1), 0n);
  assert.equal(apyFractionToBps(Number.NaN), 0n);
  assert.equal(apyFractionToBps(2), MAX_APY_BPS);
});

test("block search finds the last block at or before a time", async () => {
  // block n has timestamp 1000 + 3n (3 seconds per block, for the test)
  const ts = async (n) => 1000n + 3n * n;
  assert.equal(await findBlockAtOrBefore(ts, 100_000n, 1000n + 3n * 777n), 777n);
  assert.equal(await findBlockAtOrBefore(ts, 100_000n, 1000n + 3n * 777n + 2n), 777n, "between blocks picks the earlier one");
  assert.equal(await findBlockAtOrBefore(ts, 100_000n, 1000n + 3n * 100_000n + 50n), 100_000n, "target after latest picks latest");
  await assert.rejects(() => findBlockAtOrBefore(ts, 100_000n, 10n), /before the earliest/);
});

test("block search makes few calls", async () => {
  let calls = 0;
  const ts = async (n) => {
    calls++;
    return 1000n + 3n * n;
  };
  await findBlockAtOrBefore(ts, 5_000_000n, 1000n + 3n * 1_234_567n);
  assert.ok(calls <= 30, `used ${calls} calls`);
});

test("write only when the rate moved or the reading got old", () => {
  const base = { minChangeBps: 5n, maxAgeSeconds: 21_600 };
  assert.equal(shouldWrite({ ...base, newBps: 150n, currentBps: 150n, ageSeconds: 60 }), false);
  assert.equal(shouldWrite({ ...base, newBps: 154n, currentBps: 150n, ageSeconds: 60 }), false);
  assert.equal(shouldWrite({ ...base, newBps: 155n, currentBps: 150n, ageSeconds: 60 }), true);
  assert.equal(shouldWrite({ ...base, newBps: 150n, currentBps: 150n, ageSeconds: 21_600 }), true);
  assert.equal(shouldWrite({ ...base, newBps: 150n, currentBps: 150n, ageSeconds: Infinity }), true);
});
