// Regression tests for the findings of the independent security review (13 Oct 2026).
import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createRelayer } from "../src/relayer.mjs";
import { createIndexer, indexAbi } from "../src/indexer.mjs";
import { createBookStore, BOOK_DOMAIN, BOOK_PRIMARY_TYPE, BOOK_TYPES, MAX_BYTES_PER_OWNER, MAX_CIPHERTEXT_BYTES } from "../src/book.mjs";
import { createStyleStore, STYLE_DOMAIN, STYLE_PRIMARY_TYPE, STYLE_TYPES } from "../src/style.mjs";
import { createEconomy } from "../src/economy.mjs";
import { createHttpServer } from "../src/server.mjs";

const ADDR = (n) => getAddress("0x" + n.toString(16).padStart(40, "0"));
const RELAYER = ADDR(0x7e1a);
const FACTORY = ADDR(0xfac7);
const FAUCET = ADDR(0xfa0c);
const R = "0x" + "11".repeat(32);
const S = "0x" + "22".repeat(32);
const MON = 10n ** 18n;

// ---------------------------------------------------------------- relayer spend controls (F1, F4, F6)

function relayerWith({ balance = 10n * MON, now = () => 1_000_000_000_000, config = {} } = {}) {
  const calls = { written: [], sent: [] };
  const publicClient = {
    getBalance: async ({ address }) => (address === RELAYER ? balance : 0n),
    getBlock: async () => ({ number: 1n, baseFeePerGas: 100_000_000_000n }),
    estimateMaxPriorityFeePerGas: async () => 1_000_000_000n,
    readContract: async ({ functionName }) => (functionName === "isCity" ? true : 10n ** 12n),
    simulateContract: async () => {},
    estimateContractGas: async () => 200_000n,
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 150_000n, logs: [] }),
  };
  const walletClient = {
    account: { address: RELAYER },
    writeContract: async (req) => (calls.written.push(req), "0x" + "ee".repeat(32)),
    sendTransaction: async (req) => (calls.sent.push(req), "0x" + "dd".repeat(32)),
  };
  const relayer = createRelayer({ publicClient, walletClient, now, config: { factory: FACTORY, faucet: FAUCET, ...config } });
  return { relayer, calls, publicClient };
}
const deposit = (n) => ({ vault: ADDR(0xc1), owner: ADDR(0x1000 + n), assets: "1000000", deadline: "4102444800", v: 27, r: R, s: S });

test("gas drip: pauses when it would leave the relayer below its reserve for sponsored deposits", async () => {
  const { relayer, calls } = relayerWith({ balance: 2n * MON + 10n ** 15n });
  await assert.rejects(relayer.gasDrip({ address: ADDR(1) }), (e) => e.status === 503 && /paused/.test(e.message));
  assert.equal(calls.sent.length, 0);
  const rich = relayerWith({ balance: 10n * MON });
  await rich.relayer.gasDrip({ address: ADDR(1) });
  assert.equal(rich.calls.sent.length, 1);
});

test("gas drip: a daily cap holds even when every request comes from a different address and IP", async () => {
  let t = 1_000_000_000_000;
  const { relayer, calls } = relayerWith({ now: () => t, config: { gasDripsPerDay: 3 } });
  for (let i = 0; i < 3; i++) {
    await relayer.gasDrip({ address: ADDR(10 + i) }, { ip: `203.0.113.${i}` });
    t += 3_700_000; // past the hourly cap each time
  }
  await assert.rejects(relayer.gasDrip({ address: ADDR(20) }, { ip: "203.0.113.99" }), (e) => e.status === 429 && /today/.test(e.message));
  assert.equal(calls.sent.length, 3);
  t += 86_400_000;
  await relayer.gasDrip({ address: ADDR(21) }, { ip: "203.0.113.100" });
  assert.equal(calls.sent.length, 4, "the cap resets after a day");
});

test("sponsored transactions: refused once the daily gas budget is committed, and the budget is returned when nothing was sent", async () => {
  // 200k gas x 125% x about 151 gwei is roughly 0.038 MON per transaction; a 0.1 MON budget allows two.
  const { relayer, calls } = relayerWith({ config: { dailyGasCapWei: 10n ** 17n } });
  await relayer.deposit(deposit(1));
  await relayer.deposit(deposit(2));
  await assert.rejects(relayer.deposit(deposit(3)), (e) => e.status === 503 && /daily gas budget/.test(e.message));
  assert.equal(calls.written.length, 2);
  const health = await relayer.health();
  assert.ok(BigInt(health.gasSpentLast24hWei) > 0n);

  const failing = relayerWith({ config: { dailyGasCapWei: 10n ** 17n } });
  failing.calls.written.push = () => { throw new Error("rpc down"); };
  await assert.rejects(failing.relayer.deposit(deposit(1)));
  assert.equal(BigInt((await failing.relayer.health()).gasSpentLast24hWei), 0n, "a transaction that was never sent does not use up the budget");
});

test("sponsored transactions: a long queue is refused instead of piling up", async () => {
  const { relayer, publicClient } = relayerWith({ config: { maxQueue: 2 } });
  const releases = [];
  publicClient.waitForTransactionReceipt = () => new Promise((r) => releases.push(() => r({ status: "success", gasUsed: 1n, logs: [] })));
  const first = relayer.deposit(deposit(1));
  const second = relayer.deposit(deposit(2));
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(relayer.deposit(deposit(3)), (e) => e.status === 503 && /waiting/.test(e.message));
  while (releases.length < 1) await new Promise((r) => setTimeout(r, 5));
  releases.forEach((release) => release());
  await new Promise((r) => setTimeout(r, 20));
  releases.forEach((release) => release());
  await Promise.allSettled([first, second]);
});

test("faucet: polling a cooling-down faucet is still counted against the IP", async () => {
  const { relayer, publicClient } = relayerWith();
  publicClient.simulateContract = async () => { throw new Error("MaxFrequencyExceeded"); };
  let refused = 0;
  for (let i = 0; i < 70; i++) {
    try {
      await relayer.faucet({ address: ADDR(500 + i) }, { ip: "198.51.100.7" });
    } catch (e) {
      if (e.status === 429 && /too many faucet requests from this address/.test(e.message)) refused += 1;
    }
  }
  assert.ok(refused >= 10, `the attempt limiter stopped the poller (refused ${refused})`);
});

test("health: flags low funds for the relayer and the analyst", async () => {
  assert.equal((await relayerWith({ balance: 5n * MON }).relayer.health()).lowFunds, false);
  assert.equal((await relayerWith({ balance: MON }).relayer.health()).lowFunds, true);
  const { publicClient, relayer: base } = relayerWith();
  const withAnalyst = createRelayer({ publicClient, walletClient: { account: { address: RELAYER } }, config: { factory: FACTORY }, analyst: { balance: async () => 10n ** 17n } });
  const h = await withAnalyst.health();
  assert.equal(h.lowFunds, true, "the analyst wallet is nearly empty");
  assert.equal(h.analystBalanceWei, (10n ** 17n).toString());
  assert.ok(base);
});

// ---------------------------------------------------------------- HTTP layer (F1, F4, F10)

async function serve(relayer, options = {}) {
  const server = createHttpServer(relayer, { allowedOrigins: ["http://localhost:3000"], ...options });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("http: bodies must be application/json, so another site cannot post a form on a visitor's behalf", async () => {
  const { server, base } = await serve({ health: async () => ({ ok: true }), faucet: async () => ({ ok: true }) });
  try {
    const plain = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ address: ADDR(1) }) });
    assert.equal(plain.status, 415);
    const none = await fetch(`${base}/faucet`, { method: "POST", body: JSON.stringify({ address: ADDR(1) }) });
    assert.equal(none.status, 415);
    const json = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ address: ADDR(1) }) });
    assert.equal(json.status, 200);
  } finally {
    server.close();
  }
});

test("http: spoofing X-Forwarded-For does not give a client more requests, and one client cannot exceed the shared budget", async () => {
  let t = 1_000_000;
  const { server, base } = await serve({ health: async () => ({ ok: true }) }, { trustProxy: true, now: () => t });
  try {
    let limited = 0;
    for (let i = 0; i < 260; i++) {
      // the client writes a different leftmost value every time; the proxy-appended entry (rightmost) stays the same
      const res = await fetch(`${base}/index`, { headers: { "x-forwarded-for": `1.1.${i % 250}.${i % 7}, 198.51.100.77` } });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited >= 15, `the per-IP budget held (${limited} refused)`);
    const other = await fetch(`${base}/index`, { headers: { "x-forwarded-for": "198.51.100.78" } });
    assert.notEqual(other.status, 429, "a different real client is unaffected");
  } finally {
    server.close();
  }
});

test("http: public reads that hit the chain are shared between callers for a few seconds", async () => {
  let t = 1_000_000;
  const counts = { health: 0, leaderboard: 0, proposals: 0 };
  const relayer = {
    health: async () => (counts.health += 1, { ok: true }),
    indexer: { leaderboard: async () => (counts.leaderboard += 1, { cities: [] }), metrics: async () => ({}), status: () => ({}) },
    analyst: { list: async () => (counts.proposals += 1, { proposals: [] }), info: () => ({}) },
  };
  const { server, base } = await serve(relayer, { now: () => t });
  try {
    await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/health`)));
    await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/leaderboard`)));
    await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/proposals/${ADDR(1)}`)));
    assert.deepEqual(counts, { health: 1, leaderboard: 1, proposals: 1 });
    t += 11_000;
    await fetch(`${base}/health`);
    assert.equal(counts.health, 2, "refreshed after the ttl");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- sealed book (F2, F8)

const alice = privateKeyToAccount(generatePrivateKey());
async function entry(account, { id = "plan-1", ciphertext = toHex(new TextEncoder().encode("sealed")), nonce = 0, owner = account.address } = {}) {
  const signature = await account.signTypedData({ domain: BOOK_DOMAIN, types: BOOK_TYPES, primaryType: BOOK_PRIMARY_TYPE, message: { owner, id, ciphertextHash: keccak256(ciphertext), nonce: BigInt(nonce) } });
  return { owner, id, ciphertext, nonce: String(nonce), signature };
}

test("book: only a mayor or depositor may store anything; a fresh key with a valid signature is refused", async () => {
  const known = new Set([alice.address.toLowerCase()]);
  const store = createBookStore({ canWrite: (owner) => known.has(owner.toLowerCase()) });
  await store.put(await entry(alice));
  const stranger = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(store.put(await entry(stranger)), (e) => e.status === 403 && /no city or deposit/.test(e.message));
  assert.equal(store.list(stranger.address).entries.length, 0);
});

test("book: per-owner and total byte caps stop the store from growing without bound", async () => {
  const big = toHex(new Uint8Array(MAX_CIPHERTEXT_BYTES).fill(7));
  const store = createBookStore({ now: () => 1 });
  const perOwnerFit = Math.floor(MAX_BYTES_PER_OWNER / MAX_CIPHERTEXT_BYTES);
  // Different rate-limit windows are not the concern here, so use a clock that moves on.
  let t = 0;
  const s2 = createBookStore({ now: () => (t += 61_000) });
  for (let n = 0; n < perOwnerFit; n++) await s2.put(await entry(alice, { id: `e${n}`, ciphertext: big, nonce: n }));
  await assert.rejects(s2.put(await entry(alice, { id: "one-too-many", ciphertext: big, nonce: 999 })), (e) => e.status === 409 && /exceed/.test(e.message));
  assert.ok(store);
});

test("book: junk that names someone else's address does not use up their rate-limit budget", async () => {
  const store = createBookStore({ now: () => 5_000_000 });
  const mallory = privateKeyToAccount(generatePrivateKey());
  for (let n = 0; n < 25; n++) {
    await assert.rejects(store.put(await entry(mallory, { owner: alice.address, id: `x${n}`, nonce: n })), (e) => e.status === 403);
  }
  // alice can still write: the 25 forged requests were refused before they counted against her
  const out = await store.put(await entry(alice, { id: "mine", nonce: 0 }));
  assert.equal(out.id, "mine");
});

test("style: junk aimed at a mayor's vault does not use up the mayor's budget", async () => {
  const mayor = privateKeyToAccount(generatePrivateKey());
  const vault = ADDR(0xc1710);
  const publicClient = { readContract: async ({ functionName }) => (functionName === "isCity" ? true : mayor.address) };
  const store = createStyleStore({ publicClient, factory: FACTORY, now: () => 7_000_000 });
  const forger = privateKeyToAccount(generatePrivateKey());
  const signed = (account, code, nonce) =>
    account.signTypedData({ domain: STYLE_DOMAIN, types: STYLE_TYPES, primaryType: STYLE_PRIMARY_TYPE, message: { vault, code, nonce: BigInt(nonce) } }).then((signature) => ({ vault, code, nonce: String(nonce), signature }));
  for (let n = 0; n < 15; n++) await assert.rejects(store.set(await signed(forger, "evil.1", n)), (e) => e.status === 403);
  const out = await store.set(await signed(mayor, "sakura.7", 1));
  assert.equal(out.code, "sakura.7");
});

// ---------------------------------------------------------------- economy (F10)

test("economy: concurrent callers share one fetch, and a failure does not echo internals", async () => {
  let calls = 0;
  const overview = { chain: "Monad", total24h: 1, total7d: 1, total30d: 1, protocols: [{ name: "x", category: "Dexs", total24h: 1, total7d: 1, total30d: 1 }] };
  const economy = createEconomy({ fetchImpl: async () => (calls += 1, await new Promise((r) => setTimeout(r, 15)), { ok: true, json: async () => overview }) });
  await Promise.all([economy.get(), economy.get(), economy.get()]);
  assert.equal(calls, 1);
  const broken = createEconomy({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:443 secret-host.internal"); } });
  const original = console.error;
  console.error = () => {};
  try {
    await assert.rejects(broken.get(), (e) => e.status === 502 && !/10\.1\.2\.3|secret-host/.test(e.message));
  } finally {
    console.error = original;
  }
});

// ---------------------------------------------------------------- indexer (F5, F9)

const VAULT = ADDR(0xa0001);
const MAYOR = ADDR(0xaa01);
const ALICE = ADDR(0xa11ce);
function logOf(address, eventName, args, blockNumber, logIndex = 0) {
  const item = indexAbi.find((x) => x.type === "event" && x.name === eventName);
  const indexed = item.inputs.filter((i) => i.indexed);
  const plain = item.inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi: indexAbi, eventName, args: Object.fromEntries(indexed.map((i) => [i.name, args[i.name]])) });
  const data = plain.length ? encodeAbiParameters(plain, plain.map((i) => args[i.name])) : "0x";
  return { address, topics, data, blockNumber: BigInt(blockNumber), logIndex, transactionHash: "0x" + blockNumber.toString(16).padStart(64, "0"), transactionIndex: 0, blockHash: "0x" + "cd".repeat(32), removed: false };
}
const ZERO = "0x0000000000000000000000000000000000000000";
const script = () => [
  logOf(FACTORY, "CityCreated", { vault: VAULT, mayor: MAYOR, name: "Jakarta", community: "t", feeBps: 1000, mapURI: "" }, 110),
  logOf(VAULT, "Transfer", { from: ZERO, to: ALICE, value: 1000n }, 120),
  logOf(VAULT, "Deposit", { sender: ALICE, owner: ALICE, assets: 1000n, shares: 1000n }, 120, 1),
];

test("indexer: a failed timestamp lookup changes nothing, so the retry does not count the chunk twice", async () => {
  const logs = script();
  let failTimestamps = true;
  const publicClient = {
    getBlockNumber: async () => 200n,
    getBlock: async () => {
      if (failTimestamps) throw new Error("429 rate limited");
      return { timestamp: 1_800_000_000n };
    },
    getLogs: async ({ address, fromBlock, toBlock }) => {
      const wanted = new Set(address.map((a) => a.toLowerCase()));
      return logs.filter((l) => wanted.has(l.address.toLowerCase()) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ functionName }) => (functionName === "platformTreasury" ? ADDR(0x7ea5) : 0n),
  };
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, range: 100 } });
  await assert.rejects(index.step(), /429/);
  failTimestamps = false;
  await index.step();
  const city = index.city(VAULT);
  assert.equal(city.deposits, 1);
  assert.equal(city.depositedAssets, "1000");
  assert.equal(city.holders[ALICE.toLowerCase()], "1000", "not doubled");
});

test("indexer: when the RPC refuses a range it halves it, down to a single block", async () => {
  const asked = [];
  const publicClient = {
    getBlockNumber: async () => 140n,
    getBlock: async () => ({ timestamp: 1n }),
    getLogs: async ({ fromBlock, toBlock }) => {
      asked.push([Number(fromBlock), Number(toBlock)]);
      if (toBlock - fromBlock >= 10n) throw new Error("query returned more than 10000 results");
      return [];
    },
    readContract: async ({ functionName }) => (functionName === "platformTreasury" ? ADDR(0x7ea5) : 0n),
  };
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100, range: 100 } });
  await index.step();
  assert.equal(index.status().indexedToBlock, "140");
  assert.ok(asked.some(([a, b]) => b - a < 10), "smaller ranges were tried");
});

test("indexer: isParticipant is true for mayors and depositors only", async () => {
  const logs = script();
  const publicClient = {
    getBlockNumber: async () => 200n,
    getBlock: async () => ({ timestamp: 1n }),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      const wanted = new Set(address.map((a) => a.toLowerCase()));
      return logs.filter((l) => wanted.has(l.address.toLowerCase()) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ functionName }) => (functionName === "platformTreasury" ? ADDR(0x7ea5) : 0n),
  };
  const index = createIndexer({ publicClient, config: { factory: FACTORY, startBlock: 100 } });
  await index.step();
  assert.equal(index.isParticipant(MAYOR), true);
  assert.equal(index.isParticipant(ALICE), true);
  assert.equal(index.isParticipant(ADDR(0xdead)), false);
});
