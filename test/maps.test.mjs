import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HttpError } from "../src/guards.mjs";
import { MAP_DOMAIN, MAP_PRIMARY_TYPE, MAP_TYPES, MAX_MAP_BYTES, checkUri, createMapStore, parseMapBody } from "../src/maps.mjs";
import { createHttpServer } from "../src/server.mjs";

const ADDR = (n) => "0x" + n.toString(16).padStart(40, "0");
const FACTORY = ADDR(0xfac7);
const VAULT = ADDR(0xc1710);
const URI = "osm:-6.2088,106.8456";
const mayor = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const mapOf = (id = URI, extra = {}) => ({ id, buildings: [{ h: 12, ring: [[0, 0], [1, 0], [1, 1]] }], roads: [{ kind: "primary", line: [[0, 0], [5, 5]] }], ...extra });
const hashOf = (map) => keccak256(toBytes(JSON.stringify(map)));
const sign = (account, { vault = VAULT, uri = URI, map }) =>
  account.signTypedData({ domain: MAP_DOMAIN, types: MAP_TYPES, primaryType: MAP_PRIMARY_TYPE, message: { vault, uri, mapHash: hashOf(map) } });
const request = async (account, { vault = VAULT, uri = URI, map = mapOf(uri) } = {}) => ({ vault, map, signature: await sign(account, { vault, uri, map }) });

/** `cities` maps a vault to its mapURI; the default is one city (VAULT) on URI. */
function chain({ isCity = true, mapURI = URI, cities = { [VAULT]: mapURI } } = {}) {
  const reads = [];
  return {
    reads,
    readContract: async ({ functionName, address, args }) => {
      reads.push(functionName);
      if (functionName === "isCity") return isCity && args[0] in cities;
      if (functionName === "mayor") return mayor.address;
      if (functionName === "mapURI") return cities[address];
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}
const storeWith = ({ dir, now, chainOptions, ...rest } = {}) => createMapStore({ publicClient: chain(chainOptions), factory: FACTORY, dir, now, ...rest });
const tempDir = () => mkdtempSync(join(tmpdir(), "maps-test-"));
const status = (p) => p.then(() => 200, (e) => e.status);

test("map key: only short, plain keys", () => {
  assert.equal(checkUri("osm:-6.2088,106.8456"), "osm:-6.2088,106.8456");
  assert.equal(checkUri("osm:1.5,2.5@500m_v2"), "osm:1.5,2.5@500m_v2");
  for (const bad of ["", "../etc/passwd", "a/b", "a b", "x".repeat(81), ":osm", "osm:%00", 7, null, undefined]) {
    assert.throws(() => checkUri(bad), (e) => e instanceof HttpError && e.status === 400, String(bad));
  }
});

test("map body: validates every field", async () => {
  const good = await request(mayor);
  assert.equal(parseMapBody(URI, good).mapHash, hashOf(good.map));
  for (const over of [{ vault: "0x1" }, { signature: "0x12" }, { map: null }, { map: [] }, { map: mapOf("osm:1,1") }, { map: { id: URI, buildings: [] } }, { map: { id: URI, buildings: {}, roads: [] } }]) {
    assert.throws(() => parseMapBody(URI, { ...good, ...over }), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(over).slice(0, 80));
  }
  assert.throws(() => parseMapBody(URI, null), HttpError);
  const huge = mapOf(URI, { pad: "x".repeat(MAX_MAP_BYTES) });
  assert.throws(() => parseMapBody(URI, { ...good, map: huge }), (e) => e.status === 413);
});

test("map: the mayor's signed map is stored and anyone can read it", async () => {
  const store = storeWith();
  assert.throws(() => store.get(URI), (e) => e.status === 404);
  const req = await request(mayor);
  const out = await store.put(URI, req, { ip: "198.51.100.1" });
  assert.equal(out.uri, URI);
  assert.equal(out.vault, getAddress(VAULT));
  assert.equal(out.mapHash, hashOf(req.map));
  assert.equal(out.signer, mayor.address);
  assert.deepEqual(store.get(URI), req.map);
  assert.equal(store.size(), 1);
});

test("map: a signature from anybody but the mayor is refused and nothing is stored", async () => {
  const store = storeWith();
  assert.equal(await status(store.put(URI, await request(stranger))), 403);
  assert.equal(store.size(), 0);
});

test("map: a signature for another map, vault or key does not verify", async () => {
  const twin = ADDR(0xc1712); // a second city that picked the same spot
  const store = createMapStore({ publicClient: chain({ cities: { [VAULT]: URI, [twin]: URI } }), factory: FACTORY });
  const signed = await request(mayor);
  assert.equal(await status(store.put(URI, { ...signed, map: mapOf(URI, { extra: 1 }) })), 403, "another map than the one signed");
  assert.equal(await status(store.put(URI, { ...signed, vault: twin })), 403, "the signature names another vault");
  const other = await request(mayor, { uri: "osm:1,1" });
  assert.equal(await status(store.put(URI, { ...other, map: mapOf(URI) })), 403, "a signature made for another key");
  assert.equal(store.size(), 0);
});

test("map: the vault must be a real city whose mapURI is the key", async () => {
  assert.equal(await status(storeWith({ chainOptions: { isCity: false } }).put(URI, await request(mayor))), 400, "not created by the factory");
  assert.equal(await status(storeWith({ chainOptions: { mapURI: "osm:9,9" } }).put(URI, await request(mayor))), 400, "the city picked another spot");
});

test("map: the first signed map wins and is never replaced", async () => {
  const store = storeWith();
  const first = await request(mayor);
  await store.put(URI, first);
  const second = await request(mayor, { map: mapOf(URI, { rebuilt: true }) });
  assert.equal(await status(store.put(URI, second)), 409);
  assert.deepEqual(store.get(URI), first.map);
});

test("map: a second write is refused before any chain read", async () => {
  const client = chain();
  const store = createMapStore({ publicClient: client, factory: FACTORY });
  await store.put(URI, await request(mayor));
  const before = client.reads.length;
  assert.equal(await status(store.put(URI, await request(mayor))), 409);
  assert.equal(client.reads.length, before, "no RPC was spent on a key that is taken");
});

test("map: two writes at the same moment store one map", async () => {
  const store = storeWith();
  const a = await request(mayor, { map: mapOf(URI, { v: "a" }) });
  const b = await request(mayor, { map: mapOf(URI, { v: "b" }) });
  const results = await Promise.all([status(store.put(URI, a)), status(store.put(URI, b))]);
  assert.deepEqual(results.sort(), [200, 409]);
  assert.equal(store.size(), 1);
});

test("map: uploads are rate limited per address and overall", async () => {
  let t = 1_000_000;
  const store = storeWith({ now: () => t });
  const bad = await request(stranger);
  const results = [];
  for (let i = 0; i < 12; i++) results.push(await status(store.put(URI, bad, { ip: "198.51.100.9" })));
  assert.equal(results.filter((s) => s === 429).length, 2, "10 a minute per address, then refused");
  assert.equal(await status(store.put(URI, bad, { ip: "198.51.100.10" })), 403, "another address still gets through");
  t += 61_000;
  assert.equal(await status(store.put(URI, bad, { ip: "198.51.100.9" })), 403, "the window passed");
});

test("map: the cache stops growing at its caps", async () => {
  const VAULT2 = ADDR(0xc1711);
  const cities = { [VAULT]: URI, [VAULT2]: "osm:1,1" };
  const byCount = createMapStore({ publicClient: chain({ cities }), factory: FACTORY, maxMaps: 1 });
  await byCount.put(URI, await request(mayor));
  assert.equal(await status(byCount.put("osm:1,1", await request(mayor, { vault: VAULT2, uri: "osm:1,1" }))), 503, "over the count cap");
  assert.equal(byCount.size(), 1);
  const byBytes = createMapStore({ publicClient: chain({ cities }), factory: FACTORY, maxTotalBytes: 50 });
  assert.equal(await status(byBytes.put(URI, await request(mayor))), 503, "over the byte cap");
  assert.equal(byBytes.size(), 0);
});

test("map: files survive a restart and a damaged index starts empty", async () => {
  const dir = tempDir();
  try {
    const req = await request(mayor);
    await storeWith({ dir }).put(URI, req);
    assert.ok(existsSync(join(dir, "index.json")));
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file is left behind");
    const again = storeWith({ dir });
    assert.deepEqual(again.get(URI), req.map);
    assert.equal(await status(again.put(URI, await request(mayor))), 409, "the restored map is still the first one");
    assert.ok(!readFileSync(join(dir, "index.json"), "utf8").includes(req.signature), "the signature is not kept in the index");
    rmSync(join(dir, "index.json"));
    assert.equal(storeWith({ dir }).size(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- HTTP layer

async function serve(relayer) {
  const server = createHttpServer(relayer, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const put = (base, uri, body, headers = {}) => fetch(`${base}/map/${encodeURIComponent(uri)}`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("http: PUT then GET /map/:uri, with a day-long cache header and CORS for PUT", async () => {
  const { server, base } = await serve({ maps: storeWith() });
  try {
    const missing = await fetch(`${base}/map/${encodeURIComponent(URI)}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), null, "a miss is not cached");
    const req = await request(mayor);
    const stored = await put(base, URI, req);
    assert.equal(stored.status, 200);
    assert.equal((await stored.json()).mapHash, hashOf(req.map));
    const read = await fetch(`${base}/map/${encodeURIComponent(URI)}`);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "public, max-age=86400");
    assert.deepEqual(await read.json(), req.map);
    const preflight = await fetch(`${base}/map/${encodeURIComponent(URI)}`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "PUT" } });
    assert.match(preflight.headers.get("access-control-allow-methods"), /PUT/);
    assert.equal((await put(base, URI, req)).status, 409);
  } finally {
    server.close();
  }
});

test("http: PUT /map needs application/json, refuses a huge or broken body and a bad key", async () => {
  const { server, base } = await serve({ maps: storeWith() });
  try {
    const req = await request(mayor);
    const plain = await fetch(`${base}/map/${encodeURIComponent(URI)}`, { method: "PUT", headers: { "content-type": "text/plain" }, body: JSON.stringify(req) });
    assert.equal(plain.status, 415);
    const broken = await fetch(`${base}/map/${encodeURIComponent(URI)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.equal(broken.status, 400);
    assert.equal((await fetch(`${base}/map/${encodeURIComponent("../secrets")}`)).status, 400);
    assert.equal((await fetch(`${base}/map/%E0%A4%A`)).status, 400, "a malformed escape is a client error, not a crash");
    assert.equal((await fetch(`${base}/map/`)).status, 400);
    // Last, because the server drops the connection after refusing a body that is still being sent.
    // A client may see the reset instead of the 413 status.
    const huge = await fetch(`${base}/map/${encodeURIComponent(URI)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...req, pad: "x".repeat(800_000) }) }).then((r) => r.status, () => "reset");
    assert.ok(huge === 413 || huge === "reset", `an oversized body is refused (${huge})`);
  } finally {
    server.close();
  }
});

test("http: /map is absent when the cache is off, and /config shows the mirror adapter implementation", async () => {
  const contracts = { chainId: 10143, version: "v3", mirrorAdapterImpl: ADDR(0x3080) };
  const { server, base } = await serve({ maps: null, contracts });
  try {
    assert.equal((await fetch(`${base}/map/${encodeURIComponent(URI)}`)).status, 404);
    assert.equal((await (await fetch(`${base}/config`)).json()).mirrorAdapterImpl, ADDR(0x3080));
  } finally {
    server.close();
  }
});
