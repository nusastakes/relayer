import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HttpError } from "../src/guards.mjs";
import { BOOK_DOMAIN, BOOK_PRIMARY_TYPE, BOOK_TYPES, MAX_CIPHERTEXT_BYTES, createBookStore, parseBookBody } from "../src/book.mjs";
import { CRE_SATPAM, agentList } from "../src/agents.mjs";
import { createHttpServer } from "../src/server.mjs";

const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
const cipher = (text) => toHex(new TextEncoder().encode(text));

async function entry(account, { owner = account.address, id = "plan-1", text = "sealed bytes", nonce = 0 } = {}) {
  const ciphertext = cipher(text);
  const signature = await account.signTypedData({
    domain: BOOK_DOMAIN,
    types: BOOK_TYPES,
    primaryType: BOOK_PRIMARY_TYPE,
    message: { owner, id, ciphertextHash: keccak256(ciphertext), nonce: BigInt(nonce) },
  });
  return { owner, id, ciphertext, nonce: String(nonce), signature };
}

test("book body: validates every field", async () => {
  const good = await entry(alice);
  assert.equal(parseBookBody(good).bytes, 12);
  for (const over of [{ owner: "0x1" }, { id: "has space" }, { id: "" }, { ciphertext: "abc" }, { ciphertext: "0xabc" }, { nonce: "-1" }, { signature: "0x12" }]) {
    assert.throws(() => parseBookBody({ ...good, ...over }), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(over));
  }
  assert.throws(() => parseBookBody({ ...good, ciphertext: "0x" + "ab".repeat(MAX_CIPHERTEXT_BYTES + 1) }), (e) => e.status === 413);
  assert.throws(() => parseBookBody(null), HttpError);
});

test("book: the owner's signed entry is stored; the hash is keccak256 of the ciphertext", async () => {
  const store = createBookStore();
  const body = await entry(alice);
  const out = await store.put(body);
  assert.equal(out.hash, keccak256(body.ciphertext));
  assert.equal(out.id, "plan-1");
  assert.deepEqual(store.list(alice.address).entries.map((e) => e.id), ["plan-1"]);
  assert.equal("ciphertext" in store.list(alice.address).entries[0], false, "the list does not carry ciphertext");
  assert.equal(store.get(alice.address, "plan-1").ciphertext, body.ciphertext);
  assert.equal(store.list(alice.address).nonce, "0");
  assert.equal(store.list(mallory.address).nonce, "-1");
  assert.throws(() => store.get(alice.address, "nope"), (e) => e.status === 404);
});

test("book: nobody but the owner can write, and a signature does not carry over to other content", async () => {
  const store = createBookStore();
  await assert.rejects(store.put(await entry(mallory, { owner: alice.address })), (e) => e.status === 403);
  const good = await entry(alice);
  await assert.rejects(store.put({ ...good, ciphertext: cipher("swapped") }), (e) => e.status === 403);
  await assert.rejects(store.put({ ...good, id: "other" }), (e) => e.status === 403);
  await assert.rejects(store.put({ ...good, nonce: "5" }), (e) => e.status === 403);
  assert.equal(store.list(alice.address).entries.length, 0);
});

test("book: entries are write-once and nonces only go up", async () => {
  const store = createBookStore();
  await store.put(await entry(alice, { id: "a", nonce: 0 }));
  await assert.rejects(store.put(await entry(alice, { id: "a", nonce: 1, text: "rewritten" })), (e) => e.status === 409 && /never overwritten/.test(e.message));
  await assert.rejects(store.put(await entry(alice, { id: "b", nonce: 0 })), (e) => e.status === 409 && e.extra.currentNonce === "0");
  await store.put(await entry(alice, { id: "b", nonce: 7 }));
  assert.deepEqual(store.list(alice.address).entries.map((e) => e.id), ["a", "b"]);
  assert.equal(store.get(alice.address, "a").ciphertext, cipher("sealed bytes"), "the first write stands");
});

test("book: rate limited per owner and per IP", async () => {
  const store = createBookStore({ now: () => 1_000_000 });
  for (let n = 0; n < 20; n++) await store.put(await entry(alice, { id: `e${n}`, nonce: n }));
  await assert.rejects(store.put(await entry(alice, { id: "e20", nonce: 20 })), (e) => e.status === 429 && e.extra.retryAfterSeconds > 0);
  const other = createBookStore({ now: () => 1_000_000 });
  for (let n = 0; n < 30; n++) await other.put(await entry(privateKeyToAccount(generatePrivateKey())), { ip: "9.9.9.9" });
  await assert.rejects(other.put(await entry(alice), { ip: "9.9.9.9" }), (e) => e.status === 429);
});

test("book: survives a restart, and a corrupt file means an empty start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "book-"));
  try {
    const file = join(dir, "n", "book.json");
    await createBookStore({ file }).put(await entry(alice));
    assert.equal(createBookStore({ file }).get(alice.address, "plan-1").ciphertext, cipher("sealed bytes"));
    assert.equal(JSON.parse(readFileSync(file, "utf8"))[alice.address.toLowerCase()].nonce, "0");
    writeFileSync(file, "{broken");
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(createBookStore({ file }).list(alice.address).entries.length, 0);
    } finally {
      console.error = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents: lists Satpam, Analis and Humas with their roles and addresses", () => {
  const off = agentList({}, "0x1ADE0E93F4C10b6d57F2E802B8B4e6167f0F0ea4");
  assert.deepEqual(off.agents.map((a) => [a.id, a.role, a.status]), [["satpam", 1, "simulated"], ["analis", 2, "off"], ["humas", 3, "planned"]]);
  assert.equal(off.agents[0].address, CRE_SATPAM);
  assert.equal(CRE_SATPAM, "0x" + CRE_SATPAM.slice(2), "a valid checksummed address");
  const botAddress = "0x00000000000000000000000000000000000a11a1";
  const on = agentList({ analyst: { address: botAddress, info: () => ({ llmProviders: ["anthropic"] }) } });
  assert.equal(on.agents[1].address, botAddress);
  assert.equal(on.agents[1].status, "live");
  assert.deepEqual(on.agents[1].llm, ["anthropic"]);
});

test("book and agents over HTTP", async () => {
  const book = createBookStore();
  const server = createHttpServer({ book, health: async () => ({ ok: true }) }, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const put = await fetch(`${base}/book`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(await entry(alice)) });
    assert.equal(put.status, 200);
    const { hash } = await put.json();
    const list = await (await fetch(`${base}/book/${alice.address}`)).json();
    assert.equal(list.entries[0].hash, hash);
    const one = await (await fetch(`${base}/book/${alice.address}/plan-1`)).json();
    assert.equal(keccak256(one.ciphertext), hash);
    assert.equal((await fetch(`${base}/book/${alice.address}/missing`)).status, 404);
    assert.equal((await fetch(`${base}/book/${alice.address}/a/b`)).status, 404);
    const preflight = await fetch(`${base}/book`, { method: "OPTIONS" });
    assert.match(preflight.headers.get("access-control-allow-methods"), /PUT/);
    const agents = await (await fetch(`${base}/agents`)).json();
    assert.equal(agents.agents.length, 3);
    assert.equal(agents.guardian, "0x1ADE0E93F4C10b6d57F2E802B8B4e6167f0F0ea4");
  } finally {
    server.close();
  }
  const off = createHttpServer({ health: async () => ({ ok: true }) }, { allowedOrigins: ["*"] });
  await new Promise((r) => off.listen(0, "127.0.0.1", r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${off.address().port}/book/${alice.address}`)).status, 404);
  } finally {
    off.close();
  }
});
