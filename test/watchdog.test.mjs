import { test } from "node:test";
import assert from "node:assert/strict";

import { getAddress } from "viem";

import { createWatchdog, isTransportError, PROBE_GAS } from "../src/watchdog.mjs";
import { createHttpServer } from "../src/server.mjs";

const FACTORY = "0x00000000000000000000000000000000000fac70";
const CITY_A = getAddress("0x00000000000000000000000000000000000c1a01");
const CITY_B = getAddress("0x00000000000000000000000000000000000c1b02");
const GOOD = getAddress("0x00000000000000000000000000000000000a0001");
const BAD = getAddress("0x00000000000000000000000000000000000a0002");
const WORD = `0x${"00".repeat(31)}01`;

/** A tiny chain: cities with adapters, which of them are quarantined, and which adapters currently answer totalAssets(). */
function world({ cities = { [CITY_A]: [GOOD], [CITY_B]: [BAD] }, quarantined = new Set(), failing = new Set(), shortReturn = new Set() } = {}) {
  const ids = Object.keys(cities);
  const calls = [];
  return {
    quarantined,
    failing,
    calls,
    publicClient: {
      async readContract({ address, functionName, args }) {
        if (functionName === "cityCount") return BigInt(ids.length);
        if (functionName === "cityAt") return ids[Number(args[0])];
        if (functionName === "adapters") return cities[address];
        if (functionName === "quarantined") return quarantined.has(`${address}:${args[0]}`);
        throw new Error(`unexpected ${functionName}`);
      },
      async call({ to, gas }) {
        calls.push({ to, gas });
        if (failing.has(to)) throw new Error("execution reverted");
        return { data: shortReturn.has(to) ? "0x01" : WORD };
      },
    },
  };
}

function build(w, over = {}) {
  const sent = [];
  let t = 1_700_000_000_000;
  const dog = createWatchdog({
    publicClient: w.publicClient,
    factory: FACTORY,
    now: () => t,
    send: async (request, options) => {
      sent.push({ request, options });
      if (over.refuse) throw new Error("transaction would fail: AdapterNotBroken");
      return { hash: `0x${String(sent.length).padStart(64, "0")}` };
    },
    balance: over.balance,
    config: over.config,
  });
  return { dog, sent, advance: (ms) => { t += ms; } };
}

test("a healthy city is left alone, and the probe uses the vault's gas cap", async () => {
  const w = world({ cities: { [CITY_A]: [GOOD] } });
  const { dog, sent } = build(w);
  const r = await dog.scan();
  assert.deepEqual([r.cities, r.adapters, r.quarantined, r.actions.length, sent.length], [1, 1, 0, 0, 0]);
  assert.equal(w.calls[0].gas, PROBE_GAS);
  assert.equal(w.calls[0].gas, 3_000_000n);
});

test("an adapter that fails and is not quarantined gets quarantine, with room for the probe's gas", async () => {
  const w = world({ failing: new Set([BAD]) });
  const { dog, sent } = build(w);
  const r = await dog.scan();
  assert.equal(r.actions.length, 1);
  assert.deepEqual([r.actions[0].action, r.actions[0].city, r.actions[0].adapter, r.actions[0].result], ["quarantine", CITY_B, BAD, "sent"]);
  assert.equal(sent[0].request.functionName, "quarantine");
  assert.deepEqual(sent[0].request.args, [BAD]);
  assert.equal(sent[0].request.address, CITY_B);
  assert.ok(sent[0].options.maxGas >= 3_500_000n, "the transaction may carry more than the 3M the probe can use");
});

test("a quarantined adapter that works again gets restoreAdapter; one that still fails is left alone", async () => {
  const w = world({ cities: { [CITY_A]: [GOOD], [CITY_B]: [BAD] }, quarantined: new Set([`${CITY_A}:${GOOD}`, `${CITY_B}:${BAD}`]), failing: new Set([BAD]) });
  const { dog, sent } = build(w);
  const r = await dog.scan();
  assert.equal(r.quarantined, 2);
  assert.deepEqual(r.actions.map((a) => [a.action, a.adapter]), [["restoreAdapter", GOOD]]);
  assert.equal(sent.length, 1);
});

test("a return that is not exactly one word counts as failing, like the vault's probe", async () => {
  const w = world({ cities: { [CITY_A]: [GOOD] }, shortReturn: new Set([GOOD]) });
  const { dog, sent } = build(w);
  await dog.scan();
  assert.equal(sent[0].request.functionName, "quarantine");
});

test("a flapping adapter is acted on once per cooldown, and the hourly cap holds", async () => {
  const w = world({ cities: { [CITY_A]: [GOOD, BAD] }, failing: new Set([BAD]) });
  const { dog, sent, advance } = build(w, { config: { cooldownSeconds: 600, maxActionsPerHour: 2 } });
  await dog.scan();
  assert.equal(sent.length, 1);
  advance(60_000);
  const again = await dog.scan();
  assert.equal(again.actions[0].result, "cooldown");
  assert.equal(sent.length, 1);

  advance(11 * 60_000);
  await dog.scan(); // second action this hour
  assert.equal(sent.length, 2);
  advance(11 * 60_000);
  const capped = await dog.scan();
  assert.equal(capped.actions[0].result, "hourly-limit");
  assert.equal(sent.length, 2);
  advance(40 * 60_000); // the hour rolls over
  await dog.scan();
  assert.equal(sent.length, 3);
});

test("a low relayer balance stops it from spending", async () => {
  const w = world({ failing: new Set([BAD]) });
  const { dog, sent } = build(w, { balance: async () => 10n ** 18n });
  const r = await dog.scan();
  assert.equal(r.actions[0].result, "low-balance");
  assert.equal(sent.length, 0);
});

test("when the node refuses the transaction, the watchdog records it and carries on", async () => {
  const w = world({ failing: new Set([BAD]) });
  const { dog } = build(w, { refuse: true });
  const r = await dog.scan();
  assert.equal(r.actions[0].result, "refused");
  assert.match(r.actions[0].reason, /AdapterNotBroken/);
  assert.equal((await dog.scan()).actions[0].result, "cooldown", "even a refused attempt is not retried every scan");
});

test("a failing read of one city does not stop the scan of the others", async () => {
  const w = world({ failing: new Set([BAD]) });
  const original = w.publicClient.readContract;
  w.publicClient.readContract = async (args) => {
    if (args.address === CITY_A && args.functionName === "adapters") throw new Error("rpc dropped it");
    return original(args);
  };
  const { dog, sent } = build(w);
  const r = await dog.scan();
  assert.equal(r.cities, 1);
  assert.equal(sent.length, 1);
  assert.ok(dog.info().errors >= 1);
});

test("an overlapping scan is skipped instead of doubling the work", async () => {
  const w = world();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = w.publicClient.readContract;
  w.publicClient.readContract = async (args) => {
    if (args.functionName === "cityCount") await gate;
    return slow(args);
  };
  const { dog } = build(w);
  const first = dog.scan();
  assert.deepEqual(await dog.scan(), { skipped: "already running" });
  release();
  await first;
});

test("GET /watchdog reports the last scan", async () => {
  const w = world({ failing: new Set([BAD]) });
  const { dog } = build(w);
  await dog.scan();
  const server = createHttpServer({ watchdog: dog, health: async () => ({ ok: true }) }, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/watchdog`)).json();
    assert.equal(body.scanned, 2);
    assert.equal(body.actions[0].action, "quarantine");
    assert.equal(body.config.maxActionsPerHour, 6);
  } finally {
    server.close();
  }
});

test("a dropped request is retried, and an RPC error is never mistaken for a failing adapter", async () => {
  assert.equal(isTransportError(new Error("RPC Request failed.")), true);
  assert.equal(isTransportError(new Error("HTTP request failed. Status: 429")), true);
  assert.equal(isTransportError(new Error("execution reverted: adapter broken")), false);

  // One dropped probe is retried and then answered normally.
  const w = world({ cities: { [CITY_A]: [GOOD] } });
  let dropped = 0;
  const call = w.publicClient.call;
  w.publicClient.call = async (args) => {
    if (dropped++ < 1) throw new Error("RPC Request failed.");
    return call(args);
  };
  const first = build(w);
  const r = await first.dog.scan();
  assert.equal(r.actions.length, 0);
  assert.equal(first.sent.length, 0);

  // A probe that keeps failing at the transport level is an error, not a failing adapter: nothing is sent.
  const w2 = world({ cities: { [CITY_B]: [BAD] } });
  w2.publicClient.call = async () => {
    throw new Error("RPC Request failed.");
  };
  const second = build(w2);
  const r2 = await second.dog.scan();
  assert.equal(r2.actions.length, 0);
  assert.equal(second.sent.length, 0);
  assert.ok(second.dog.info().errors >= 1);
  assert.match(second.dog.info().lastError, /RPC Request failed/);
});
