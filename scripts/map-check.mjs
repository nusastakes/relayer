#!/usr/bin/env node
// Checks the city map cache (PUT/GET /map/:uri) on a hosted relayer with a real mayor signature on Monad testnet.
//
//   RELAYER_URL=https://relayer-production-39e1.up.railway.app node scripts/map-check.mjs
//
// It needs no key: the mayor is a new wallet that gets its MON from the relayer's /gas-drip, founds a city named
// "Map cache test (ignore)" with a fresh mapURI, and then
//   1. a stranger's signature is refused (403),
//   2. the mayor's signature is accepted (200) and GET returns the same map with a day-long Cache-Control,
//   3. a second PUT for the same key is refused (409) and the first map stays,
//   4. a map whose hash was not signed is refused (403).
// It sends real testnet transactions (a gas drip and createCity) and leaves one extra city on the leaderboard.

import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseEventLogs, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MAP_DOMAIN, MAP_PRIMARY_TYPE, MAP_TYPES } from "../src/maps.mjs";

const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const base = (process.env.RELAYER_URL || "https://relayer-production-39e1.up.railway.app").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const factoryAbi = parseAbi([
  "function createCity(string name, string community, uint16 feeBps, address[] adapterImpls, string mapURI) returns (address vault)",
  "event CityCreated(address indexed vault, address indexed mayor, string name, string community, uint16 feeBps, string mapURI)",
]);

const config = await (await fetch(`${base}/config`)).json();
if (!config.mirrorAdapterImpl) throw new Error("/config has no mirrorAdapterImpl");
const mayor = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: mayor, chain, transport: http(RPC) });

// A key nobody else uses: a spot in the Gulf of Guinea with a random tail.
const tail = () => String(Math.floor(Math.random() * 1e5)).padStart(5, "0");
const uri = `osm:0.${tail()},0.${tail()}@360`;
// The same shape the web app builds from Overpass (src/lib/osm.ts), small enough to read.
const map = {
  id: uri,
  name: "Map cache test",
  attribution: "© OpenStreetMap contributors",
  buildings: Array.from({ length: 6 }, (_, i) => ({ h: 9 + i, k: i % 2, c: i, a: 120 + i, p: [i * 10, 0, i * 10 + 8, 0, i * 10 + 8, 8, i * 10, 8] })),
  roads: [{ w: 6, f: 0, p: [-20, 20, 80, 20] }],
};
const mapHash = (m) => keccak256(toBytes(JSON.stringify(m)));
const sign = (account, vault, m) => account.signTypedData({ domain: MAP_DOMAIN, types: MAP_TYPES, primaryType: MAP_PRIMARY_TYPE, message: { vault, uri, mapHash: mapHash(m) } });
const put = async (body) => {
  const res = await fetch(`${base}/map/${encodeURIComponent(uri)}`, { method: "PUT", headers: { "content-type": "application/json", origin: "http://localhost:3100" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null), cors: res.headers.get("access-control-allow-origin") };
};
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function tightFees() {
  const block = await pub.getBlock();
  const tip = await pub.estimateMaxPriorityFeePerGas().catch(() => 0n);
  return { maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + tip, maxPriorityFeePerGas: tip };
}

console.log("relayer", base, "| mayor", mayor.address, "| key", uri);
let drip;
for (let i = 0; i < 4 && !drip; i++) {
  const res = await fetch(`${base}/gas-drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: mayor.address }) });
  const json = await res.json();
  if (res.ok) drip = json;
  else if (res.status === 429 || res.status >= 500) await sleep(3000 * (i + 1));
  else throw new Error(`gas-drip ${res.status}: ${JSON.stringify(json)}`);
}
if (!drip) throw new Error("gas-drip kept failing");
console.log("gas drip tx", drip.hash);
await sleep(3000);

const args = ["Map cache test (ignore)", "MAPCHECK", 1000, [config.mirrorAdapterImpl], uri];
const gas = ((await pub.estimateContractGas({ address: config.factory, abi: factoryAbi, functionName: "createCity", args, account: mayor })) * 11n) / 10n;
const hash = await wallet.writeContract({ address: config.factory, abi: factoryAbi, functionName: "createCity", args, gas, ...(await tightFees()) });
const receipt = await pub.waitForTransactionReceipt({ hash });
const [created] = parseEventLogs({ abi: factoryAbi, eventName: "CityCreated", logs: receipt.logs });
const vault = created.args.vault;
console.log("createCity tx", hash, "vault", vault);

const before = await fetch(`${base}/map/${encodeURIComponent(uri)}`);
check("GET before any PUT is 404", before.status === 404, String(before.status));

const forged = await put({ vault, map, signature: await sign(stranger, vault, map) });
check("a stranger's signature is refused", forged.status === 403, `${forged.status} ${forged.body?.error}`);

const other = { ...map, buildings: map.buildings.slice(0, 3) };
const mismatch = await put({ vault, map: other, signature: await sign(mayor, vault, map) });
check("a map other than the one signed is refused", mismatch.status === 403, `${mismatch.status} ${mismatch.body?.error}`);

const ok = await put({ vault, map, signature: await sign(mayor, vault, map) });
check("the mayor's signed map is accepted", ok.status === 200 && ok.body?.mapHash === mapHash(map) && ok.body?.signer === mayor.address, `${ok.status} ${JSON.stringify(ok.body)}`);
check("PUT answers the browser origin (CORS)", ok.cors === "http://localhost:3100", String(ok.cors));

const read = await fetch(`${base}/map/${encodeURIComponent(uri)}`);
const text = await read.text();
check("GET returns exactly the stored map", read.status === 200 && text === JSON.stringify(map), `${read.status}, ${text.length} bytes`);
check("GET carries Cache-Control: public, max-age=86400", read.headers.get("cache-control") === "public, max-age=86400", String(read.headers.get("cache-control")));

const again = await put({ vault, map: other, signature: await sign(mayor, vault, other) });
check("a second map for the same key is refused", again.status === 409, `${again.status} ${again.body?.error}`);
const still = await (await fetch(`${base}/map/${encodeURIComponent(uri)}`)).text();
check("the first map is still the one served", still === JSON.stringify(map));

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ uri, vault, mayor: mayor.address, txs: { gasDrip: drip.hash, createCity: hash }, passed: results.length - failed.length, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
