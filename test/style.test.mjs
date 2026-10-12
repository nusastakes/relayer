import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HttpError } from "../src/guards.mjs";
import { STYLE_DOMAIN, STYLE_PRIMARY_TYPE, STYLE_TYPES, createStyleStore, parseStyleBody } from "../src/style.mjs";

const ADDR = (n) => "0x" + n.toString(16).padStart(40, "0");
const FACTORY = ADDR(0xfac7);
const VAULT = ADDR(0xc1710);
const mayor = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const sign = (account, { vault = VAULT, code, nonce }) =>
  account.signTypedData({ domain: STYLE_DOMAIN, types: STYLE_TYPES, primaryType: STYLE_PRIMARY_TYPE, message: { vault, code, nonce: BigInt(nonce) } });

function storeWith({ file, isCity = true, now } = {}) {
  const publicClient = { readContract: async ({ functionName }) => (functionName === "isCity" ? isCity : mayor.address) };
  return createStyleStore({ publicClient, factory: FACTORY, file, now });
}
const request = async (account, code, nonce, vault = VAULT) => ({ vault, code, nonce: String(nonce), signature: await sign(account, { vault, code, nonce }) });

test("style body: validates every field", async () => {
  const good = await request(mayor, "sakura.7", 1);
  assert.equal(parseStyleBody(good).code, "sakura.7");
  assert.equal(parseStyleBody({ ...good, code: "" }).code, "", "an empty code clears the style");
  for (const over of [{ vault: "0x1" }, { code: "Sakura.7" }, { code: "no-dot" }, { code: "a".repeat(40) + ".1" }, { nonce: "-1" }, { nonce: "1.5" }, { signature: "0x12" }]) {
    assert.throws(() => parseStyleBody({ ...good, ...over }), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(over));
  }
  assert.throws(() => parseStyleBody(null), HttpError);
});

test("style: the mayor's signed style is stored and readable by anyone", async () => {
  const store = storeWith();
  assert.deepEqual(store.get(VAULT), { code: "", nonce: "0" });
  const out = await store.set(await request(mayor, "sakura.7", 1));
  assert.deepEqual(out, { vault: VAULT, code: "sakura.7", nonce: "1" });
  assert.deepEqual(store.get(VAULT), { code: "sakura.7", nonce: "1" });
  assert.deepEqual(store.get(VAULT.toUpperCase().replace("0X", "0x")), { code: "sakura.7", nonce: "1" }, "address case does not matter");
});

test("style: a signature from anybody but the mayor is refused", async () => {
  const store = storeWith();
  await assert.rejects(store.set(await request(stranger, "evil.1", 1)), (e) => e.status === 403);
  assert.equal(store.get(VAULT).code, "");
});

test("style: a signature for another code, vault or nonce does not verify", async () => {
  const store = storeWith();
  const signed = await request(mayor, "sakura.7", 1);
  await assert.rejects(store.set({ ...signed, code: "other.1" }), (e) => e.status === 403);
  await assert.rejects(store.set({ ...signed, nonce: "2" }), (e) => e.status === 403);
  await assert.rejects(store.set({ ...signed, vault: ADDR(0xbeef) }), (e) => e.status === 403);
});

test("style: nonces only go up, so an old signed message cannot be replayed", async () => {
  const store = storeWith();
  const first = await request(mayor, "sakura.7", 5);
  await store.set(first);
  await assert.rejects(store.set(first), (e) => e.status === 409 && e.extra.currentNonce === "5");
  await assert.rejects(store.set(await request(mayor, "old.1", 4)), (e) => e.status === 409);
  await store.set(await request(mayor, "", 6));
  assert.deepEqual(store.get(VAULT), { code: "", nonce: "6" });
});

test("style: a vault the factory did not create is refused", async () => {
  const store = storeWith({ isCity: false });
  await assert.rejects(store.set(await request(mayor, "sakura.7", 1)), (e) => e.status === 400 && /factory/.test(e.message));
});

test("style: limits repeated requests for one city and from one address", async () => {
  const store = storeWith({ now: () => 1_000_000 });
  for (let n = 1; n <= 10; n++) await store.set(await request(mayor, `t.${n}`, n));
  await assert.rejects(store.set(await request(mayor, "t.11", 11)), (e) => e.status === 429 && e.extra.retryAfterSeconds > 0);

  const other = storeWith({ now: () => 1_000_000 });
  for (let n = 1; n <= 30; n++) await other.set(await request(mayor, "t.1", 1, ADDR(0x1000 + n)), { ip: "9.9.9.9" });
  await assert.rejects(other.set(await request(mayor, "t.1", 1, ADDR(0x2000)), { ip: "9.9.9.9" }), (e) => e.status === 429);
  await other.set(await request(mayor, "t.1", 1, ADDR(0x2000)), { ip: "8.8.8.8" });
});

test("style: survives a restart through the JSON file, and a corrupt file means an empty start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "style-"));
  try {
    const file = join(dir, "nested", "styles.json");
    await storeWith({ file }).set(await request(mayor, "sakura.7", 3));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { [VAULT.toLowerCase()]: { code: "sakura.7", nonce: "3" } });
    assert.deepEqual(storeWith({ file }).get(VAULT), { code: "sakura.7", nonce: "3" });

    writeFileSync(file, "{not json");
    const original = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(storeWith({ file }).get(VAULT), { code: "", nonce: "0" });
    } finally {
      console.error = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("style over HTTP: POST then GET, and the routes are absent when the store is off", async () => {
  const { createHttpServer } = await import("../src/server.mjs");
  const style = storeWith();
  const serve = async (relayer) => {
    const server = createHttpServer(relayer, { allowedOrigins: ["http://localhost:3000"] });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const { server, base } = await serve({ style, health: async () => ({ ok: true, styleEnabled: true }) });
  try {
    const post = await fetch(`${base}/style`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await request(mayor, "sakura.7", 1)) });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { vault: VAULT, code: "sakura.7", nonce: "1" });
    const get = await fetch(`${base}/style/${VAULT}`, { headers: { origin: "http://localhost:3000" } });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.deepEqual(await get.json(), { code: "sakura.7", nonce: "1" });
    assert.equal((await fetch(`${base}/style/nope`)).status, 400);
    const replay = await fetch(`${base}/style`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await request(mayor, "sakura.7", 1)) });
    assert.equal(replay.status, 409);
  } finally {
    server.close();
  }
  const off = await serve({ health: async () => ({ ok: true, styleEnabled: false }) });
  try {
    assert.equal((await fetch(`${off.base}/style/${VAULT}`)).status, 404);
  } finally {
    off.server.close();
  }
});
