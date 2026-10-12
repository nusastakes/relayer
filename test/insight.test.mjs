import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, toHex } from "viem";
import { createIndexer, indexAbi } from "../src/indexer.mjs";
import { DEFILLAMA_URL, createEconomy, groupBySector } from "../src/economy.mjs";
import { buildFacts, createHumas, keepsFigures, templateReport } from "../src/humas.mjs";
import { createPlanStore } from "../src/analyst.mjs";
import { agentList } from "../src/agents.mjs";
import { createHttpServer } from "../src/server.mjs";

const ADDR = (n) => getAddress("0x" + n.toString(16).padStart(40, "0"));
const FACTORY = ADDR(0xfac7);
const GUARDIAN = ADDR(0x9a);
const VAULT_A = ADDR(0xa0001);
const VAULT_B = ADDR(0xb0002);
const MAYOR_A = ADDR(0xaa01);
const MAYOR_B = ADDR(0xbb02);
const TREASURY = ADDR(0x7ea5);
const ALICE = ADDR(0xa11ce);
const BOB = ADDR(0xb0b);
const ZERO = "0x0000000000000000000000000000000000000000";
const HUMAS = ADDR(0x4a5);
const hash = (n) => "0x" + n.toString(16).padStart(64, "0");

// ---------------------------------------------------------------- a fake chain made of logs

function logOf(address, eventName, args, blockNumber, logIndex = 0) {
  const item = indexAbi.find((x) => x.type === "event" && x.name === eventName);
  const indexed = item.inputs.filter((i) => i.indexed);
  const plain = item.inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi: indexAbi, eventName, args: Object.fromEntries(indexed.map((i) => [i.name, args[i.name]])) });
  const data = plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name])) : "0x";
  return { address, topics, data, blockNumber: BigInt(blockNumber), logIndex, transactionHash: hash(blockNumber * 100 + logIndex), transactionIndex: 0, blockHash: hash(blockNumber), removed: false };
}
const created = (vault, mayor, name, block) => logOf(FACTORY, "CityCreated", { vault, mayor, name, community: "test", feeBps: 1000, mapURI: "ipfs://x" }, block);
const transfer = (vault, from, to, value, block, i = 0) => logOf(vault, "Transfer", { from, to, value }, block, i);
const deposit = (vault, owner, assets, shares, block, i = 1) => logOf(vault, "Deposit", { sender: owner, owner, assets, shares }, block, i);

const NOW = 1_800_000_000;
function chain({ logs, head = 400, infos = [], timeOfBlock = (b) => NOW - (head - Number(b)) * 60 } = {}) {
  const requests = [];
  const publicClient = {
    getBlockNumber: async () => BigInt(head),
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(timeOfBlock(blockNumber)) }),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      requests.push({ address, fromBlock, toBlock });
      const wanted = new Set(address.map((a) => a.toLowerCase()));
      return logs.filter((l) => wanted.has(l.address.toLowerCase()) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ functionName }) => {
      if (functionName === "platformTreasury") return TREASURY;
      if (functionName === "cityInfos") return infos;
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  return { publicClient, requests };
}
const info = (vault, mayor, name, pps, tvl, createdAt = 1) => ({ vault, mayor, name, community: "test", mapURI: "", feeBps: 1000, createdAt: BigInt(createdAt), totalAssets: tvl, totalSupply: 1n, pricePerShare: pps, adapters: [] });

const script = () => [
  created(VAULT_A, MAYOR_A, "Jakarta", 120),
  transfer(VAULT_A, ZERO, ALICE, 1_000n, 130),
  deposit(VAULT_A, ALICE, 1_000n, 1_000n, 130),
  transfer(VAULT_A, ZERO, BOB, 500n, 140),
  deposit(VAULT_A, BOB, 500n, 500n, 140),
  transfer(VAULT_A, ZERO, MAYOR_A, 5n, 150), // fee shares to the mayor: not a resident
  transfer(VAULT_A, ZERO, TREASURY, 1n, 150, 1), // platform cut: not a resident
  logOf(VAULT_A, "FeeAccrued", { feeShares: 6n, platformShares: 1n, mayorShares: 5n, newHighWaterMark: 10n ** 18n }, 150, 2),
  logOf(VAULT_A, "Rebalanced", { caller: MAYOR_A, from: ZERO, to: ADDR(0xada), amount: 700n, planHash: hash(0xabc) }, 160),
  transfer(VAULT_A, BOB, ZERO, 500n, 170), // Bob leaves
  logOf(VAULT_A, "Withdraw", { sender: BOB, receiver: BOB, owner: BOB, assets: 500n, shares: 500n }, 170, 1),
  created(VAULT_B, MAYOR_B, "Jogja", 180),
  transfer(VAULT_B, ZERO, MAYOR_B, 800n, 190),
  deposit(VAULT_B, MAYOR_B, 800n, 800n, 190), // the mayor deposits her own money: she is a resident
  logOf(VAULT_A, "Evacuated", { adapter: ADDR(0xada), amount: 700n }, 200),
];

// ---------------------------------------------------------------- indexer

test("indexer: finds cities, counts residents without fee recipients, and keeps a ledger", async () => {
  const { publicClient } = chain({ logs: script() });
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, range: 100 }, now: () => NOW * 1000 });
  const out = await index.step();
  assert.equal(out.behind, 0);
  assert.deepEqual(index.cities().map((c) => c.name), ["Jakarta", "Jogja"]);
  assert.deepEqual(index.residentsOf(VAULT_A), [ALICE.toLowerCase()], "Bob withdrew everything; the mayor and the treasury only hold fee shares and never deposited");
  assert.deepEqual(index.residentsOf(VAULT_B), [MAYOR_B.toLowerCase()], "a mayor who deposited counts as a resident");
  const types = index.ledgerOf(VAULT_A).map((e) => e.type);
  assert.deepEqual(types, ["deposit", "deposit", "fee", "rebalance", "withdraw", "evacuate"]);
  assert.equal(index.ledgerOf(VAULT_A)[0].ts, NOW - (400 - 130) * 60, "events carry their block timestamp");
  assert.equal(index.city(VAULT_A).deposits, 2);
  assert.equal(index.city(VAULT_A).withdrawals, 1);
});

test("indexer: a city created inside a chunk does not double count the events of the chunk", async () => {
  const logs = [created(VAULT_A, MAYOR_A, "Jakarta", 110), transfer(VAULT_A, ZERO, ALICE, 1_000n, 111), deposit(VAULT_A, ALICE, 1_000n, 1_000n, 111)];
  const { publicClient, requests } = chain({ logs });
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, range: 100 } });
  await index.step();
  assert.equal(index.city(VAULT_A).deposits, 1);
  assert.equal(index.city(VAULT_A).depositedAssets, "1000");
  assert.equal(index.city(VAULT_A).holders[ALICE.toLowerCase()], "1000");
  assert.ok(requests.some((r) => r.address.length === 2), "the chunk was read again with the new vault in the filter");
});

test("indexer: walks in chunks of the configured range and stops after the request budget", async () => {
  const { publicClient, requests } = chain({ logs: [], head: 1000 });
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, range: 100, maxRequestsPerStep: 3 } });
  const first = await index.step();
  assert.equal(first.requests, 3);
  assert.deepEqual(requests.map((r) => [Number(r.fromBlock), Number(r.toBlock)]), [[100, 199], [200, 299], [300, 399]]);
  assert.equal(index.status().complete, false);
  for (let i = 0; i < 5; i++) await index.step();
  assert.equal(index.status().indexedToBlock, "1000");
  assert.equal(index.status().complete, true);
});

test("indexer: getLogs can go to a separate client while other reads stay on the main one", async () => {
  const main = chain({ logs: [] , head: 150 });
  const logsOnly = chain({ logs: script(), head: 150 });
  main.publicClient.getLogs = async () => { throw new Error("the main client must not serve getLogs"); };
  const index = createIndexer({ publicClient: main.publicClient, logsClient: logsOnly.publicClient, config: { factory: FACTORY, startBlock: 100, range: 100 } });
  await index.step();
  assert.ok(logsOnly.requests.length > 0);
  assert.equal(index.cities().length, 1, "the city created at block 120 was found through the logs client");
});

test("indexer: resumes from its file and does not read old blocks again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "index-"));
  try {
    const file = join(dir, "n", "index.json");
    const first = chain({ logs: script() });
    await createIndexer({ publicClient: first.publicClient, config: { factory: FACTORY, startBlock: 100 }, file }).step();
    const second = chain({ logs: script(), head: 450 });
    const again = createIndexer({ publicClient: second.publicClient, config: { factory: FACTORY, startBlock: 100 }, file });
    assert.equal(again.cities().length, 2);
    await again.step();
    assert.ok(second.requests.every((r) => r.fromBlock >= 401n), "only the new blocks");
    assert.deepEqual(again.residentsOf(VAULT_A), [ALICE.toLowerCase()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexer: leaderboard ranks by return with live TVL, and metrics add up across cities", async () => {
  const withSupply = (i) => ({ ...i, totalSupply: i.totalAssets });
  const infos = [
    withSupply(info(VAULT_A, MAYOR_A, "Jakarta", 1_012_000_000_000_000_000n, 5_000_000n)),
    withSupply(info(VAULT_B, MAYOR_B, "Jogja", 1_030_000_000_000_000_000n, 2_000_000n)),
    // an emptied city with one unit of dust and no shares: the share price reads +100% but means nothing
    { ...info(ADDR(0xc0003), MAYOR_B, "Kosong", 2_000_000_000_000_000_000n, 1n), totalSupply: 0n },
  ];
  const { publicClient } = chain({ logs: script(), infos });
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100 }, now: () => NOW * 1000 });
  await index.step();
  const board = await index.leaderboard();
  assert.deepEqual(board.cities.map((c) => [c.rank, c.name, c.returnBps, c.residents, c.ranked]), [[1, "Jogja", 300, 1, true], [2, "Jakarta", 120, 1, true], [null, "Kosong", 0, 0, false]]);
  const m = await index.metrics();
  assert.deepEqual([m.cities, m.mayors, m.residents, m.tvl, m.deposits, m.withdrawals], [3, 2, 2, "7000001", 3, 1]);
});

test("indexer: hourly snapshots of price and total assets, capped, and only when due", async () => {
  let t = NOW * 1000;
  const infos = [info(VAULT_A, MAYOR_A, "Jakarta", 10n ** 18n, 1_000n)];
  const { publicClient } = chain({ logs: [], infos, head: 120 });
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, snapshotIntervalSeconds: 3600 }, now: () => t });
  await index.step();
  await index.step();
  assert.equal(index.snapshotsOf(VAULT_A).length, 1, "not due again yet");
  t += 3_601_000;
  await index.step();
  assert.deepEqual(index.snapshotsOf(VAULT_A).map((s) => s.tvl), ["1000", "1000"]);
});

// ---------------------------------------------------------------- economy

const OVERVIEW = {
  chain: "Monad",
  total24h: 3000,
  total7d: 20000,
  total30d: 90000,
  protocols: [
    { name: "curve", displayName: "Curve DEX", category: "Dexs", total24h: 1000.4, total7d: 7000, total30d: 30000 },
    { name: "uni", category: "Dexs", total24h: 500, total7d: 3000, total30d: 20000 },
    { name: "morpho", displayName: "Morpho", category: "Lending", total24h: 1500, total7d: 10000, total30d: 40000 },
    { name: "dead", category: "Lending", total24h: null, total7d: null, total30d: null },
  ],
};

test("economy: groups protocols by sector, biggest 30-day sector first, null fees count as zero", () => {
  const s = groupBySector(OVERVIEW);
  assert.deepEqual(s.map((x) => [x.sector, x.fees24h, x.fees30d, x.protocols]), [["Lending", 1500, 40000, 2], ["Dexs", 1500, 50000, 2]].sort((a, b) => b[2] - a[2]));
  assert.equal(s[0].sector, "Dexs");
  assert.deepEqual(s[0].top.map((t) => t.name), ["Curve DEX", "uni"]);
});

test("economy: names its source and time, caches, and falls back to stale data when DefiLlama is down", async () => {
  let t = 1_000_000;
  let calls = 0;
  let healthy = true;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, DEFILLAMA_URL);
    return healthy ? { ok: true, json: async () => OVERVIEW } : { ok: false, status: 503 };
  };
  const economy = createEconomy({ fetchImpl, now: () => t, ttlMs: 60_000 });
  const first = await economy.get();
  assert.equal(first.sourceUrl, DEFILLAMA_URL);
  assert.equal(first.fetchedAt, 1000);
  assert.equal(first.totals.fees30d, 90000);
  await economy.get();
  assert.equal(calls, 1, "cached");
  t += 61_000;
  healthy = false;
  const stale = await economy.get();
  assert.equal(stale.stale, true);
  assert.equal(stale.totals.fees30d, 90000);
  const cold = createEconomy({ fetchImpl, now: () => t });
  await assert.rejects(cold.get(), (e) => e.status === 502);
});

// ---------------------------------------------------------------- humas

const ledgerFor = () => [
  { type: "deposit", ts: NOW - 5 * 86400, assets: "1000000000", owner: ALICE },
  { type: "deposit", ts: NOW - 10 * 86400, assets: "9000000000", owner: ALICE },
  { type: "withdraw", ts: NOW - 2 * 86400, assets: "200000000", owner: ALICE },
  { type: "rebalance", ts: NOW - 4 * 86400, from: ZERO, to: ADDR(0xada), amount: "475000000", planHash: hash(0xabc), tx: hash(1) },
  { type: "rebalance", ts: NOW - 3 * 86400, from: ZERO, to: ADDR(0xada), amount: "100000000", planHash: hash(0xdef), tx: hash(2) },
  { type: "evacuate", ts: NOW - 1 * 86400, adapter: ADDR(0xada), amount: "575000000" },
];

test("humas facts: only the period counts, return comes from snapshots, reasons are matched by planHash", () => {
  const f = buildFacts({
    city: VAULT_A,
    name: "Jakarta",
    days: 7,
    now: NOW,
    ledger: ledgerFor(),
    snapshots: [{ ts: NOW - 6 * 86400, pps: (10n ** 18n).toString(), tvl: "1000000000" }],
    live: { totalAssets: 1_100_000_000n, pricePerShare: 1_012_000_000_000_000_000n },
    residents: 3,
    planReasons: { [hash(0xabc)]: "Kas menganggur terlalu besar." },
    sealedHashes: { [hash(0xdef)]: true },
  });
  assert.equal(f.returnBps, 120n);
  assert.equal(f.deposits.count, 1);
  assert.equal(f.deposits.assets, 1_000_000_000n, "the deposit from ten days ago is outside the week");
  assert.equal(f.withdrawals.assets, 200_000_000n);
  assert.deepEqual(f.rebalances.map((r) => [r.reason, r.sealed]), [["Kas menganggur terlalu besar.", false], [null, true]]);
  assert.equal(f.evacuations.length, 1);
});

test("humas template: Indonesian, states the figures, the movements with reasons, and the source", () => {
  const f = buildFacts({ city: VAULT_A, name: "Jakarta", days: 7, now: NOW, ledger: ledgerFor(), snapshots: [{ ts: NOW - 6 * 86400, pps: (10n ** 18n).toString(), tvl: "1000000000" }], live: { totalAssets: 1_100_000_000n, pricePerShare: 1_012_000_000_000_000_000n }, residents: 3, planReasons: { [hash(0xabc)]: "Kas menganggur terlalu besar." }, sealedHashes: { [hash(0xdef)]: true } });
  const text = templateReport(f);
  assert.match(text, /Laporan 7 hari untuk Jakarta/);
  assert.match(text, /harga share naik 1\.20%/);
  assert.match(text, /1000\.00 menjadi 1100\.00 AUSD, dengan 3 penduduk/);
  assert.match(text, /1 setoran senilai 1000\.00 AUSD dan 1 penarikan senilai 200\.00 AUSD/);
  assert.match(text, /475\.00 AUSD dari kas ke adapter; alasan: Kas menganggur terlalu besar\./);
  assert.match(text, /buku strategi tersegel/);
  assert.match(text, /Evakuasi Satpam: 1 kali, total 575\.00 AUSD/);
  assert.match(text, /Sumber: event on-chain/);
  assert.match(text, /Catatan: riwayat harga hanya tersedia sejak/, "the first snapshot is a day after the period start");
  const fullHistory = templateReport(buildFacts({ city: VAULT_A, name: "Jakarta", days: 7, now: NOW, ledger: [], snapshots: [{ ts: NOW - 7 * 86400 + 600, pps: (10n ** 18n).toString(), tvl: "1000000000" }], live: { totalAssets: 1_000_000_000n, pricePerShare: 10n ** 18n }, residents: 1, planReasons: {}, sealedHashes: {} }));
  assert.doesNotMatch(fullHistory, /Catatan: riwayat harga/, "history covers the whole period");
  const shortHistory = templateReport(buildFacts({ city: VAULT_A, name: "Jakarta", days: 7, now: NOW, ledger: [], snapshots: [{ ts: NOW - 3600 * 2, pps: (10n ** 18n).toString(), tvl: "1000000000" }], live: { totalAssets: 1_000_000_000n, pricePerShare: 10n ** 18n }, residents: 1, planReasons: {}, sealedHashes: {} }));
  assert.match(shortHistory, /Catatan: riwayat harga hanya tersedia sejak .* WIB, jadi hasil di atas mencakup periode itu, bukan seluruh 7 hari/);
  const noHistory = templateReport({ ...f, returnBps: null, startTvl: null });
  assert.match(noHistory, /belum cukup/);
});

test("humas: rewritten text must keep the figures, otherwise the template stands", () => {
  const f = { endTvl: 1_100_000_000n, returnBps: 120n };
  assert.equal(keepsFigures("Aset 1100.00 AUSD, naik 1.20%.", f), true);
  assert.equal(keepsFigures("Aset 1100,00 AUSD, naik 1,20%.", f), true, "comma decimals are fine");
  assert.equal(keepsFigures("Aset naik pesat!", f), false);
});

function humasWith({ hired = true, cityKnown = true, llm = [] } = {}) {
  const publicClient = {
    readContract: async ({ functionName }) => {
      if (functionName === "isActiveAgent") return hired;
      if (functionName === "totalAssets") return 1_100_000_000n;
      if (functionName === "pricePerShare") return 1_012_000_000_000_000_000n;
      throw new Error(functionName);
    },
  };
  const indexer = {
    city: () => (cityKnown ? { name: "Jakarta", mayor: MAYOR_A } : null),
    ledgerOf: () => ledgerFor(),
    snapshotsOf: () => [{ ts: NOW - 6 * 86400, pps: (10n ** 18n).toString(), tvl: "1000000000" }],
    residentsOf: () => [ALICE, BOB, MAYOR_A],
    status: () => ({ complete: true }),
  };
  const store = createPlanStore();
  store.put(hash(0xabc), { city: VAULT_A, reason: "Kas menganggur terlalu besar.", createdAt: NOW - 4 * 86400 });
  return createHumas({ publicClient, indexer, address: HUMAS, config: { guardian: GUARDIAN }, analystStore: store, llm, now: () => NOW * 1000 });
}

test("humas: reports only for cities that hired it, only for known cities, and validates input", async () => {
  assert.equal((await humasWith({ hired: false }).report(VAULT_A)).status, "not-hired");
  assert.equal((await humasWith({ cityKnown: false }).report(VAULT_A)).status, "unknown-city");
  await assert.rejects(humasWith().report("nope"), (e) => e.status === 400);
  await assert.rejects(humasWith().report(VAULT_A, "0"), (e) => e.status === 400);
  await assert.rejects(humasWith().report(VAULT_A, "31"), (e) => e.status === 400);
  const ok = await humasWith().report(VAULT_A, "7");
  assert.equal(ok.status, "ok");
  assert.equal(ok.writtenBy, "template");
  assert.equal(ok.facts.returnBps, 120);
  assert.equal(ok.facts.rebalances[0].reason, "Kas menganggur terlalu besar.", "the Analyst's stored reason is matched by planHash");
  assert.equal(ok.facts.rebalances.length, 2);
});

test("humas: an LLM rewrite is used when it keeps the figures, dropped when it does not, and the report is cached", async () => {
  let calls = 0;
  const mk = (text) => ({ provider: "anthropic", apiKey: "k", fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) }; } });
  const good = humasWith({ llm: [mk("Minggu ini harga share naik 1.20% dan aset menjadi 1100.00 AUSD.")] });
  const a = await good.report(VAULT_A);
  assert.equal(a.writtenBy, "llm");
  await good.report(VAULT_A);
  assert.equal(calls, 1, "cached for ten minutes");
  const bad = humasWith({ llm: [mk("Kota ini luar biasa!")] });
  assert.equal((await bad.report(VAULT_A)).writtenBy, "template");
});

test("agents: Humas is live once configured", () => {
  const list = agentList({ humas: { address: HUMAS, info: () => ({ llmProviders: ["xkiro"] }) } }, GUARDIAN);
  const humas = list.agents.find((a) => a.id === "humas");
  assert.deepEqual([humas.status, humas.address, humas.llm], ["live", HUMAS, ["xkiro"]]);
});

// ---------------------------------------------------------------- HTTP

test("leaderboard, metrics, economy and report over HTTP; absent when not configured", async () => {
  const board = { cities: [], index: {} };
  const relayer = {
    health: async () => ({ ok: true }),
    indexer: { leaderboard: async () => board, metrics: async () => ({ cities: 2 }), status: () => ({ complete: true }) },
    economy: { get: async () => ({ sectors: [] }) },
    humas: { report: async (city, days) => ({ city, days: days ?? "default" }) },
  };
  const server = createHttpServer(relayer, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/leaderboard`)).json(), board);
    assert.equal((await (await fetch(`${base}/metrics`)).json()).cities, 2);
    assert.equal((await (await fetch(`${base}/index`)).json()).complete, true);
    assert.deepEqual((await (await fetch(`${base}/economy`)).json()).sectors, []);
    assert.deepEqual(await (await fetch(`${base}/report/${VAULT_A}?days=14`)).json(), { city: VAULT_A, days: "14" });
    assert.equal((await (await fetch(`${base}/report/${VAULT_A}`)).json()).days, "default");
  } finally {
    server.close();
  }
  const off = createHttpServer({ health: async () => ({ ok: true }) }, { allowedOrigins: ["*"] });
  await new Promise((r) => off.listen(0, "127.0.0.1", r));
  try {
    for (const path of ["/leaderboard", "/metrics", "/economy", `/report/${VAULT_A}`]) assert.equal((await fetch(`http://127.0.0.1:${off.address().port}${path}`)).status, 404, path);
  } finally {
    off.close();
  }
});
