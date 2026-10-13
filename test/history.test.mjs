import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from "viem";
import { createIndexer, indexAbi } from "../src/indexer.mjs";
import { SEEDS, createCatalog, loadImpls, percentToBps, pickPools, sourceIdOf } from "../src/catalog.mjs";
import { createServiceJobs } from "../src/services.mjs";

const ADDR = (n) => getAddress("0x" + n.toString(16).padStart(40, "0"));
const FACTORY = ADDR(0xfac7);
const GUARDIAN = ADDR(0x9a);
const MARKET = ADDR(0x3a);
const SERVICES = ADDR(0x5e);
const VAULT = ADDR(0xa0001);
const MAYOR = ADDR(0xaa01);
const ALICE = ADDR(0xa11ce);
const BOB = ADDR(0xb0b);
const AGENT = ADDR(0xa9e);
const TOKEN = ADDR(0x70c);
const ZERO = "0x0000000000000000000000000000000000000000";
const hash = (n) => "0x" + n.toString(16).padStart(64, "0");
const NOW = 1_800_000_000;
const DAY = 86_400;

/** Logs with an explicit transaction, so events of one transaction can share it. */
function logOf(address, eventName, args, blockNumber, logIndex = 0, tx = hash(blockNumber * 100 + logIndex)) {
  const item = indexAbi.find((x) => x.type === "event" && x.name === eventName);
  const indexed = item.inputs.filter((i) => i.indexed);
  const plain = item.inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi: indexAbi, eventName, args: Object.fromEntries(indexed.map((i) => [i.name, args[i.name]])) });
  const data = plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name])) : "0x";
  return { address, topics, data, blockNumber: BigInt(blockNumber), logIndex, transactionHash: tx, transactionIndex: 0, blockHash: hash(blockNumber), removed: false };
}

// One block per hour going back from block 1000 = NOW, so a block's age in days is easy to place.
const HEAD = 1000;
const timeOfBlock = (b) => NOW - (HEAD - Number(b)) * 3600;
function chain(logs, head = HEAD) {
  const requests = [];
  return {
    requests,
    publicClient: {
      getBlockNumber: async () => BigInt(head),
      getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(timeOfBlock(blockNumber)) }),
      getLogs: async ({ address, fromBlock, toBlock }) => {
        requests.push({ address, fromBlock, toBlock });
        const wanted = new Set(address.map((a) => a.toLowerCase()));
        return logs.filter((l) => wanted.has(l.address.toLowerCase()) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
      readContract: async ({ functionName }) => {
        if (functionName === "platformTreasury") return ADDR(0x7ea5);
        if (functionName === "cityCount") return 0n;
        throw new Error(`unexpected read ${functionName}`);
      },
    },
  };
}

const daysAgo = (d) => HEAD - Math.round(d * 24); // block number d days before NOW
const script = () => {
  const old = daysAgo(10);
  const b = daysAgo(2);
  return [
    logOf(FACTORY, "CityCreated", { vault: VAULT, mayor: MAYOR, name: "Jakarta", community: "t", feeBps: 1000, mapURI: "x" }, old - 5),
    // 10 days ago: outside the 7-day window
    logOf(VAULT, "Deposit", { sender: ALICE, owner: ALICE, assets: 9_000_000n, shares: 9_000_000n }, old, 1),
    // inside the window
    logOf(VAULT, "Deposit", { sender: ALICE, owner: ALICE, assets: 100_000_000n, shares: 100_000_000n }, b, 1),
    logOf(VAULT, "Deposit", { sender: MAYOR, owner: MAYOR, assets: 50_000_000n, shares: 50_000_000n }, b + 1, 1),
    logOf(VAULT, "Withdraw", { sender: ALICE, receiver: ALICE, owner: ALICE, assets: 30_000_000n, shares: 30_000_000n }, b + 2, 1),
    logOf(VAULT, "Rebalanced", { caller: MAYOR, from: ZERO, to: ADDR(0xada), amount: 70_000_000n, planHash: hash(1) }, b + 3),
    // a paid hire: Hired (marketplace) then AgentGranted (guardian) in one transaction
    logOf(MARKET, "Hired", { listingId: 1n, agentId: 7n, client: MAYOR, agentWallet: AGENT, capability: hash(2), until: BigInt(NOW + DAY), paidToAgent: 950_000n, fee: 50_000n }, b + 4, 0, hash(0xbeef)),
    logOf(GUARDIAN, "AgentGranted", { city: VAULT, agent: AGENT, role: 2, expiry: BigInt(NOW + DAY) }, b + 4, 1, hash(0xbeef)),
    // services: switched on, a launch (detail before money), a trade (money before detail), a market and a prediction
    logOf(SERVICES, "ServiceSet", { city: VAULT, kind: 1, on: true, feeBps: 100 }, b + 5),
    logOf(SERVICES, "TokenLaunched", { city: VAULT, token: TOKEN, creator: BOB, name: "Kopi", symbol: "KOPI" }, b + 6, 0, hash(0xc1)),
    logOf(SERVICES, "ServiceUsed", { city: VAULT, kind: 1, user: BOB, volume: 1_000_000n, fee: 1_000_000n }, b + 6, 1, hash(0xc1)),
    logOf(SERVICES, "ServiceUsed", { city: VAULT, kind: 1, user: BOB, volume: 20_000_000n, fee: 200_000n }, b + 7, 0, hash(0xc2)),
    logOf(SERVICES, "Traded", { city: VAULT, token: TOKEN, user: BOB, buy: true, ausd: 20_000_000n, tokens: 123n, fee: 200_000n }, b + 7, 1, hash(0xc2)),
    logOf(SERVICES, "MarketOpened", { id: 3n, city: VAULT, sourceId: hash(0x5), thresholdBps: 600, closesAt: BigInt(NOW - 3600), resolvesAt: BigInt(NOW - 60) }, b + 8),
    logOf(SERVICES, "Predicted", { id: 3n, user: ALICE, above: true, amount: 10_000_000n, fee: 100_000n }, b + 9, 0, hash(0xc3)),
    logOf(SERVICES, "ServiceUsed", { city: VAULT, kind: 2, user: ALICE, volume: 10_000_000n, fee: 100_000n }, b + 9, 1, hash(0xc3)),
    logOf(SERVICES, "FeesReleased", { city: VAULT, amount: 600_000n }, b + 10),
  ];
};
const indexerFor = (logs, extra = {}) =>
  createIndexer({ publicClient: chain(logs).publicClient, config: { factory: FACTORY, startBlock: 100, range: 100, maxRequestsPerStep: 1000, guardian: GUARDIAN, market: MARKET, services: SERVICES, ...extra }, now: () => NOW * 1000 });

test("history: totals count outside users' traffic, keep rebalances apart, and pair service events", async () => {
  const index = indexerFor(script());
  await index.step();
  const h = index.history(VAULT, 7);
  assert.equal(h.days, 7);
  const t = h.totals;
  assert.equal(t.deposits, "150000000", "the deposit 10 days ago is outside the window");
  assert.equal(t.withdrawals, "30000000");
  assert.equal(t.netFlow, "120000000");
  assert.equal(t.rebalanceVolume, "70000000");
  assert.equal(t.rebalanceCount, 1);
  assert.equal(t.hires, 1);
  assert.equal(t.hirePayments, "1000000", "paid to the agent plus the marketplace fee");
  assert.equal(t.serviceUses, 3);
  assert.equal(t.serviceVolume, "31000000");
  assert.equal(t.serviceFees, "1300000", "fees earned, whether or not released yet");
  assert.equal(t.feesReleased, "600000");
  // traffic = deposits 150 + withdrawals 30 + services 31 + hire 1 = 212 AUSD; the mayor's deposit (50) and hire (1) are not outside traffic
  assert.equal(t.traffic, "212000000");
  assert.equal(t.outsideTraffic, "161000000");
  assert.equal(t.uniqueUsers, 2, "Alice and Bob; the mayor is not counted");
  const types = h.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 4), ["fees-released", "predict", "market-open", "trade"], "newest first");
  const launch = h.events.find((e) => e.type === "launch");
  assert.equal(launch.amount, "1000000");
  assert.equal(launch.symbol, "KOPI");
  const trade = h.events.find((e) => e.type === "trade");
  assert.equal(trade.fee, "200000");
  assert.equal(trade.buy, true);
  assert.equal(h.events.find((e) => e.type === "hire").user, MAYOR);
  assert.equal(h.events.find((e) => e.type === "deposit").amount, "50000000");
  assert.equal(h.services[1].feeBps, 100);
  assert.equal(h.tokens[0].symbol, "KOPI");
  assert.deepEqual(h.markets.map((m) => m.id), ["3"]);
  assert.equal(h.truncated, false);
  assert.ok(h.events.every((e) => !("li" in e)));
});

test("history: unknown city is null, and days is clamped to 1..30", async () => {
  const index = indexerFor(script());
  await index.step();
  assert.equal(index.history(ADDR(0xdead), 7), null);
  assert.equal(index.history(VAULT, 400).days, 30);
  assert.equal(index.history(VAULT, 0).days, 7, "0 is not a valid window: the default is used");
  assert.equal(index.history(VAULT, 30).totals.deposits, "159000000", "30 days include the old deposit");
});

test("history: open markets and cities with fees feed the resolver and the releaser", async () => {
  const index = indexerFor([...script(), logOf(SERVICES, "MarketResolved", { id: 3n, outcome: 1, apyBps: 640 }, daysAgo(1))]);
  await index.step();
  assert.deepEqual(index.openMarkets(), []);
  assert.deepEqual(index.serviceCities(), [VAULT]);
  const before = indexerFor(script());
  await before.step();
  assert.deepEqual(before.openMarkets(), [{ id: "3", city: VAULT, sourceId: hash(0x5), closesAt: NOW - 3600, resolvesAt: NOW - 60 }]);
});

test("indexer: a contract added after the walk passed its first block is backfilled in chain order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  try {
    const file = join(dir, "index.json");
    const logs = script();
    // First run without the services contract: the walk reaches the head.
    await createIndexer({ publicClient: chain(logs).publicClient, config: { factory: FACTORY, startBlock: 100, range: 100, maxRequestsPerStep: 1000, guardian: GUARDIAN, market: MARKET }, file, now: () => NOW * 1000 }).step();
    // Second run with it, starting at its deploy block: one backfill job, then the same totals as a fresh index.
    const { publicClient, requests } = chain(logs);
    const again = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, range: 100, maxRequestsPerStep: 1000, guardian: GUARDIAN, market: MARKET, services: SERVICES, servicesFromBlock: daysAgo(3) }, file, now: () => NOW * 1000 });
    assert.ok(again.status().backfillBlocks > 0);
    const r = await again.step();
    assert.equal(r.backfill, 0);
    assert.ok(requests.some((q) => q.address.length === 1 && q.address[0] === SERVICES), "the backfill reads only the new contract");
    const fresh = indexerFor(logs);
    await fresh.step();
    assert.deepEqual(again.history(VAULT, 7).totals, fresh.history(VAULT, 7).totals);
    const blocks = again.ledgerOf(VAULT).map((e) => Number(e.block));
    assert.deepEqual(blocks, [...blocks].sort((x, y) => x - y), "the ledger is back in chain order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexer: without extra contracts the address filter is unchanged", async () => {
  const { publicClient, requests } = chain(script());
  await createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, range: 1000 } }).step();
  assert.ok(requests.every((q) => !q.address.includes(SERVICES) && !q.address.includes(GUARDIAN)));
});

// ---------------------------------------------------------------- catalog

test("catalog: sourceId is keccak256 of the pool id, except the primary service", () => {
  const aave = SEEDS.find((s) => s.id === "aave-ausd");
  assert.equal(sourceIdOf(aave, hash(9)), keccak256(toHex(aave.pool)));
  assert.equal(sourceIdOf(SEEDS[0], hash(9)), hash(9));
  assert.equal(SEEDS.length, 18);
  assert.equal(new Set(SEEDS.map((s) => s.id)).size, 18);
});

test("catalog: DefiLlama pools are picked by id and converted to basis points", () => {
  const pools = pickPools([{ pool: SEEDS[1].pool, apy: 5.84244, tvlUsd: 3161972.4 }, { pool: "other", apy: 1 }, { pool: SEEDS[2].pool, apy: null, tvlUsd: "x" }]);
  assert.deepEqual(pools.get(SEEDS[1].pool), { apyBps: 584, tvlUsd: 3161972 });
  assert.deepEqual(pools.get(SEEDS[2].pool), { apyBps: 0, tvlUsd: null });
  assert.equal(pools.has("other"), false);
  assert.equal(percentToBps(-3), 0);
  assert.equal(percentToBps(129.6), 12960);
});

test("catalog: impls come from the file, live values from DefiLlama, the primary APY from the feed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"));
  try {
    const implsFile = join(dir, "impls.json");
    writeFileSync(implsFile, JSON.stringify({ "aave-ausd": ADDR(0x1111), "bad id!": ADDR(1), "euler-ausd": "not-an-address" }));
    assert.deepEqual(loadImpls(implsFile), { "aave-ausd": ADDR(0x1111) });
    assert.deepEqual(loadImpls(join(dir, "missing.json")), {});
    const feedReads = [];
    const publicClient = {
      readContract: async ({ args }) => {
        feedReads.push(args[0]);
        return args[0] === hash(9) ? [612, 1700n, 1800n] : [0, 0n, 0n];
      },
    };
    const mainnetClient = { readContract: async () => 3_500_000_000_000n };
    const yields = { get: async () => ({ fetchedAt: 1234, pools: new Map([[SEEDS[1].pool, { apyBps: 590, tvlUsd: 3_000_000 }]]) }), status: () => ({ error: null }) };
    const cat = createCatalog({ publicClient, mainnetClient, yields, feed: ADDR(0xfeed), primarySourceId: hash(9), primaryVault: ADDR(0x9999), mirrorImpl: ADDR(0x2222), cityServices: SERVICES, implsFile });
    const out = await cat.get();
    assert.equal(out.services.length, 18);
    const primary = out.services[0];
    assert.equal(primary.impl, ADDR(0x2222));
    assert.equal(primary.apyBps, 612);
    assert.equal(primary.tvlUsd, 3_500_000);
    assert.equal(primary.source, "apyfeed");
    const aave = out.services.find((s) => s.id === "aave-ausd");
    assert.equal(aave.impl, ADDR(0x1111));
    assert.equal(aave.apyBps, 590);
    assert.equal(aave.observedAt, 1234);
    assert.equal(aave.source, "defillama");
    assert.equal(aave.feed, null, "no value on the feed yet");
    const euler = out.services.find((s) => s.id === "euler-ausd");
    assert.equal(euler.impl, null);
    assert.equal(euler.source, "seed");
    assert.equal(euler.apyBps, 895);
    assert.equal(out.services.find((s) => s.id === "uniswap-wmon-usdc").feedClamped, true);
    assert.deepEqual(out.kinds.map((k) => [k.kind, k.id, k.contract]), [[1, "launchpad", SERVICES], [2, "prediction", SERVICES]]);
    assert.equal(feedReads.length, 2, "the feed is read only for services with an implementation");
    assert.deepEqual(cat.sources().map((s) => s.id), ["morpho-grove", "aave-ausd"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- resolver and releaser

test("resolver: writes the market's source first when the feed is older than resolvesAt, then resolves", async () => {
  const calls = [];
  let updatedAt = BigInt(NOW - 600);
  const publicClient = { readContract: async ({ functionName }) => (functionName === "latest" ? [600, updatedAt, updatedAt] : [0n, 0n]) };
  const jobs = createServiceJobs({
    publicClient,
    send: async (req) => {
      calls.push(`${req.functionName}(${req.args.join(",")})`);
      return { hash: hash(0x77) };
    },
    indexer: { openMarkets: () => [{ id: "3", sourceId: hash(5), resolvesAt: NOW - 60 }, { id: "4", sourceId: hash(5), resolvesAt: NOW + 600 }], serviceCities: () => [] },
    address: SERVICES,
    feed: ADDR(0xfeed),
    writeSource: async (sourceId) => {
      calls.push(`writeSource(${sourceId})`);
      updatedAt = BigInt(NOW);
    },
    now: () => NOW * 1000,
  });
  const done = await jobs.resolveDue();
  assert.deepEqual(calls, [`writeSource(${hash(5)})`, "resolve(3)"], "market 4 is not due yet");
  assert.equal(done.length, 1);
  await jobs.resolveDue();
  assert.equal(calls.length, 2, "no second try within two minutes");
});

test("releaser: releases only cities with an amount due, at most every 30 minutes", async () => {
  let t = NOW * 1000;
  const sent = [];
  const due = { [VAULT]: 5n, [ADDR(0xb2)]: 0n };
  const jobs = createServiceJobs({
    publicClient: { readContract: async ({ args }) => [due[args[0]], 9n] },
    send: async (req) => {
      sent.push(req.args[0]);
      return { hash: hash(1) };
    },
    indexer: { openMarkets: () => [], serviceCities: () => [VAULT, ADDR(0xb2)] },
    address: SERVICES,
    feed: ADDR(0xfeed),
    now: () => t,
  });
  await jobs.releaseDue();
  assert.deepEqual(sent, [VAULT]);
  t += 10 * 60_000;
  await jobs.releaseDue();
  assert.deepEqual(sent, [VAULT], "too soon for the same city");
  t += 25 * 60_000;
  await jobs.releaseDue();
  assert.deepEqual(sent, [VAULT, VAULT]);
  assert.equal(jobs.info().recent[0].status, "released");
});
