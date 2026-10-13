import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CAPABILITY_BY_ROLE, COMMUNITY_ROLES, MAX_LISTED, cleanText, createMarketplace, fetchCard, isPublicIp, validateCard } from "../src/marketplace.mjs";
import { ERC8004_TESTNET, createAgentIdentity } from "../src/erc8004.mjs";
import { agentList } from "../src/agents.mjs";
import { createHttpServer } from "../src/server.mjs";

const GUARDIAN = "0x1ade0e93f4c10b6d57f2e802b8b4e6167f0f0ea4";
const CITY = "0x887AC9965980f680dEbd08A30e2FB33aE99F2397";
const OWNER = "0x00000000000000000000000000000000000000a1";
const WALLET = "0x00000000000000000000000000000000000000b2";
const registry = `eip155:10143:${ERC8004_TESTNET.identityRegistry}`;

const goodCard = (agentId = 9, over = {}) => ({
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Contoh Analis",
  description: "Proposes rebalances.",
  services: [{ name: "web", endpoint: "https://agent.example/" }],
  registrations: [{ agentId, agentRegistry: registry }],
  nusastakes: { capability: "nusastakes.city-staff", roleId: 2, pricing: { model: "free" } },
  ...over,
});
const dataUri = (card) => `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;

test("isPublicIp: private, loopback, link-local, CGNAT, metadata and mapped forms are refused", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "198.18.0.5", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "not-an-ip"]) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicIp(ip), true, ip);
});

test("cleanText: control, zero-width and bidi characters become spaces, and length is capped", () => {
  const dirty = `a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c${String.fromCharCode(0x200b)}d${String.fromCharCode(0x2028)}e\n  f`;
  assert.equal(cleanText(dirty, 50), "a b c d e f");
  assert.equal(cleanText("x".repeat(500), 10).length, 10);
  assert.equal(cleanText(42, 10), "");
});

test("fetchCard: data URIs are decoded locally and nothing else but public https is allowed", async () => {
  const card = goodCard();
  assert.deepEqual(await fetchCard(dataUri(card)), card);
  assert.deepEqual(await fetchCard(`data:application/json,${encodeURIComponent(JSON.stringify(card))}`), card);
  const neverCalled = { resolve: async () => { throw new Error("dns must not be asked"); }, get: async () => { throw new Error("network must not be touched"); } };
  for (const uri of ["http://agent.example/c.json", "ftp://agent.example/c.json", "ipfs://bafy", "https://127.0.0.1/c.json", "https://[::1]/c.json", "https://8.8.8.8/c.json", "https://localhost/c.json", "https://printer.local/c.json", "https://agent.example:8443/c.json", "https://user:pw@agent.example/c.json", "data:text/html,<script>", "javascript:alert(1)", "", "x".repeat(5000)]) {
    await assert.rejects(() => fetchCard(uri, neverCalled), (e) => e.status === 400, uri.slice(0, 40));
  }
  await assert.rejects(() => fetchCard(`data:application/json,${"x".repeat(40_000)}`), /larger than/);
});

test("fetchCard: every DNS answer must be public, and the connection goes to the checked address with the real hostname", async () => {
  const seen = [];
  const get = async (args) => {
    seen.push(args);
    return { status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(goodCard()) };
  };
  assert.equal((await fetchCard("https://agent.example/cards/9.json?v=2", { resolve: async () => [{ address: "93.184.216.34" }], get })).name, "Contoh Analis");
  assert.equal(seen[0].ip, "93.184.216.34");
  assert.equal(seen[0].hostname, "agent.example");
  assert.equal(seen[0].path, "/cards/9.json?v=2");
  for (const answers of [[{ address: "10.0.0.5" }], [{ address: "93.184.216.34" }, { address: "169.254.169.254" }], []]) {
    await assert.rejects(() => fetchCard("https://agent.example/c.json", { resolve: async () => answers, get }), /non-public/);
  }
  await assert.rejects(() => fetchCard("https://nope.example/c.json", { resolve: async () => { throw new Error("ENOTFOUND"); }, get }), /does not resolve/);
});

test("fetchCard: redirects, non-JSON and invalid JSON are refused", async () => {
  const resolve = async () => [{ address: "93.184.216.34" }];
  const reply = (r) => ({ resolve, get: async () => r });
  await assert.rejects(() => fetchCard("https://a.example/c", reply({ status: 302, contentType: "text/html", body: "" })), /HTTP 302/);
  await assert.rejects(() => fetchCard("https://a.example/c", reply({ status: 200, contentType: "text/html", body: "<html>" })), /not JSON/);
  await assert.rejects(() => fetchCard("https://a.example/c", reply({ status: 200, contentType: "application/json", body: "{oops" })), /not valid JSON/);
  await assert.rejects(() => fetchCard("https://a.example/c", { resolve, get: async () => { throw new Error("socket hang up"); } }), /could not be loaded/);
});

test("validateCard: accepts the documented shape and rejects everything that would mislead a mayor", () => {
  const ok = validateCard(goodCard(9), { agentId: "9", agentRegistry: registry });
  assert.deepEqual([ok.roleId, ok.role, ok.pricing, ok.services.length], [2, "ANALIS", { model: "free" }, 1]);
  const check = (card, why) => assert.throws(() => validateCard(card, { agentId: "9", agentRegistry: registry }), (e) => e.status === 400 && why.test(e.message), String(why));
  check(null, /not a JSON object/);
  check(goodCard(9, { type: "x" }), /"type"/);
  check(goodCard(9, { name: "  " }), /"name"/);
  check(goodCard(10), /registrations/);
  check(goodCard(9, { registrations: [{ agentId: 9, agentRegistry: "eip155:1:0x1" }] }), /registrations/);
  check(goodCard(9, { nusastakes: undefined }), /nusastakes/);
  check(goodCard(9, { nusastakes: { capability: "other", roleId: 2 } }), /capability/);
  check(goodCard(9, { nusastakes: { capability: "nusastakes.city-staff", roleId: 1 } }), /SATPAM is reserved/);
  check(goodCard(9, { nusastakes: { capability: "nusastakes.city-staff", roleId: 4 } }), /roleId/);
  const rich = validateCard(goodCard(9, { name: `<b>x</b>${String.fromCharCode(0x202e)}`, nusastakes: { capability: "nusastakes.city-staff", roleId: 3, pricing: { model: "x402", amount: "$0.05" } } }), { agentId: "9", agentRegistry: registry });
  assert.equal(rich.role, "HUMAS");
  assert.deepEqual(rich.pricing, { model: "x402", amount: "$0.05" });
  assert.equal(rich.name, "<b>x</b>", "markup is kept as text for the frontend to escape, but invisible characters are gone");
  assert.deepEqual(validateCard(goodCard(9, { nusastakes: { capability: "nusastakes.city-staff", roleId: 2, pricing: { model: "get-rich" } } }), { agentId: "9", agentRegistry: registry }).pricing, { model: "free" });
  assert.deepEqual(COMMUNITY_ROLES, { 2: "ANALIS", 3: "HUMAS" });
});

/** A chain with agents 9 (analyst) and 10 (humas) in the registry, and a mayor who hired agent 9's wallet in CITY. */
const MARKET = "0x00000000000000000000000000000000000ba5e1";
const listingOf = (over = {}) => ({ agentId: 9n, seller: OWNER, asset: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", price: 250000n, period: 604800, capability: CAPABILITY_BY_ROLE[2], active: true, uri: "", ...over });

function fixture({ cards = {}, owners = {}, hired = [WALLET], reputation = {}, listings = {} } = {}) {
  const wallets = { 9: WALLET, 10: "0x00000000000000000000000000000000000000c3", 11: "0x0000000000000000000000000000000000000000" };
  const uris = { 9: dataUri(goodCard(9)), 10: dataUri(goodCard(10, { nusastakes: { capability: "nusastakes.city-staff", roleId: 3, pricing: { model: "x402", amount: "$0.01" } } })), 11: dataUri(goodCard(11)), ...cards };
  const publicClient = {
    async readContract({ functionName, args, address }) {
      const id = args?.[0] !== undefined && typeof args[0] === "bigint" ? Number(args[0]) : null;
      if (address === MARKET) {
        const all = Object.values(listings).flat();
        if (functionName === "listingIdsOf") return (listings[id] ?? []).map((l) => BigInt(all.indexOf(l)));
        if (functionName === "getListing") return all[id];
        if (functionName === "statsOf") return { hires: 3n, lastHireAt: 1700000000n, revenue: 750000n };
      }
      if (functionName === "ownerOf") { if (!(id in wallets)) throw new Error("ERC721NonexistentToken"); return owners[id] ?? OWNER; }
      if (functionName === "getAgentWallet") return wallets[id];
      if (functionName === "tokenURI") return uris[id];
      if (functionName === "isActiveAgent") return hired.includes(args[1]);
      if (functionName === "getClients") return reputation[id] ? ["0x00000000000000000000000000000000000000d4"] : [];
      if (functionName === "getSummary") return [1n, BigInt(reputation[id]), 0];
      throw new Error(`unexpected ${functionName}`);
    },
  };
  const identity = createAgentIdentity({ publicClient, baseUrl: "https://r.example", deployments: { agents: { analis: { agentId: "2231" } } } });
  return { publicClient, identity };
}

function build(fx, over = {}) {
  const team = () => agentList({ identity: fx.identity }, GUARDIAN).agents.map((a) => ({ ...a, address: a.id === "analis" ? "0x00000000000000000000000000000000000a11a1" : a.address }));
  return createMarketplace({ ...fx, guardian: GUARDIAN, teamAgents: team, isCity: async (a) => a.toLowerCase() === CITY.toLowerCase(), ...over });
}

test("apply: a verified agent is listed, and applying again updates instead of duplicating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "market-"));
  try {
    const file = join(dir, "m.json");
    const m = build(fixture(), { file });
    const first = await m.apply({ agentId: 9 }, { ip: "1.1.1.1" });
    assert.equal(first.listed, true);
    assert.equal(first.updated, false);
    assert.deepEqual([first.agent.id, first.agent.wallet, first.agent.role], ["erc8004:9", "0x00000000000000000000000000000000000000b2", "ANALIS"]);
    assert.equal((await m.apply({ agentId: "9" }, { ip: "1.1.1.1" })).updated, true);
    assert.equal(m.size(), 1);
    // A restart keeps the listing.
    assert.equal(build(fixture(), { file }).size(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply: refuses bad ids, missing agents, empty wallets, team ids, bad files, and floods", async () => {
  const m = build(fixture(), { ipLimit: 1000, globalLimit: 1000 });
  const ip = { ip: "2.2.2.2" };
  for (const bad of [undefined, null, -1, 1.5, "abc", "1e3", "12345678901234", {}, []]) await assert.rejects(() => m.apply({ agentId: bad }, ip), (e) => e.status === 400, String(bad));
  await assert.rejects(() => m.apply({ agentId: 99 }, ip), (e) => e.status === 404);
  await assert.rejects(() => m.apply({ agentId: 11 }, ip), /no wallet/);
  await assert.rejects(() => m.apply({ agentId: 2231 }, ip), (e) => e.status === 409);
  const broken = build(fixture({ cards: { 9: dataUri(goodCard(9, { nusastakes: { capability: "nope", roleId: 2 } })) } }), { ipLimit: 1000, globalLimit: 1000 });
  await assert.rejects(() => broken.apply({ agentId: 9 }, ip), /capability/);
  const limited = build(fixture());
  let blocked = 0;
  for (let i = 0; i < 8; i++) await limited.apply({ agentId: 9 }, { ip: "3.3.3.3" }).catch((e) => { if (e.status === 429) blocked += 1; });
  assert.equal(blocked, 3, "five applications per hour per address");
});

test("apply: the exchange holds a bounded number of community agents", async () => {
  const fx = fixture();
  const many = createMarketplace({
    publicClient: { async readContract({ functionName, args }) { const id = Number(args[0]); return functionName === "ownerOf" ? OWNER : functionName === "getAgentWallet" ? WALLET : `uri-${id}`; } },
    identity: fx.identity,
    guardian: GUARDIAN,
    teamAgents: () => [],
    isCity: async () => true,
    cardFetcher: async (uri) => goodCard(Number(uri.slice(4))),
    ipLimit: 1000,
    globalLimit: 1000,
  });
  for (let i = 0; i < MAX_LISTED; i++) await many.apply({ agentId: 1000 + i }, {}).catch((e) => assert.fail(`${i}: ${e.message}`));
  await assert.rejects(() => many.apply({ agentId: 5000 }, {}), (e) => e.status === 503);
  assert.equal((await many.apply({ agentId: 1000 }, {})).updated, true, "an existing listing can still be refreshed when the exchange is full");
});

test("list: team and community agents, ranked by reputation, with hire status for a city", async () => {
  const fx = fixture({ reputation: { 9: 95, 2231: 90 } });
  const m = build(fx);
  await m.apply({ agentId: 9 }, {});
  await m.apply({ agentId: 10 }, {});
  const all = await m.list();
  assert.equal(all.capability, "nusastakes.city-staff");
  assert.equal(all.count, 5);
  assert.deepEqual(all.agents.slice(0, 2).map((a) => a.id), ["erc8004:9", "analis"], "highest average first");
  assert.equal(all.agents.find((a) => a.id === "humas").pricing.model, "free", "team Humas shows free until its x402 route is on");
  assert.equal(all.agents.find((a) => a.id === "erc8004:10").pricing.model, "x402");
  assert.equal(all.agents.find((a) => a.id === "satpam").hire.role, 1);
  assert.ok(all.agents.every((a) => a.hiredInCity === undefined), "no city, no hire status");
  assert.equal(all.agents.find((a) => a.id === "erc8004:9").rate.agentId, "9");

  const inCity = await m.list({ city: CITY });
  assert.equal(inCity.agents.find((a) => a.id === "erc8004:9").hiredInCity, true);
  assert.equal(inCity.agents.find((a) => a.id === "erc8004:10").hiredInCity, false);
  await assert.rejects(() => m.list({ city: "nope" }), (e) => e.status === 400);
  await assert.rejects(() => m.list({ city: "0x00000000000000000000000000000000000000ee" }), (e) => e.status === 404);
});

test("list: an agent whose owner changed since it applied is shown as changed and cannot be hired", async () => {
  const fx = fixture();
  let owner = OWNER;
  const dynamic = { readContract: async (a) => (a.functionName === "ownerOf" ? owner : fx.publicClient.readContract(a)) };
  const live = build({ ...fx, publicClient: dynamic });
  await live.apply({ agentId: 9 }, {});
  owner = "0x00000000000000000000000000000000000000f9";
  const entry = (await live.list()).agents.find((a) => a.id === "erc8004:9");
  assert.equal(entry.status, "changed-since-application");
  assert.equal(entry.hireable, false);
});

test("HTTP: GET /marketplace and POST /marketplace/apply, with the JSON content type required", async () => {
  const fx = fixture({ reputation: { 9: 80 } });
  const marketplace = build(fx);
  const server = createHttpServer({ marketplace, health: async () => ({ ok: true }) }, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/marketplace/apply`, { method: "POST", body: JSON.stringify({ agentId: 9 }) })).status, 415);
    const applied = await fetch(`${url}/marketplace/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: 9 }) });
    assert.equal(applied.status, 200);
    const list = await (await fetch(`${url}/marketplace`)).json();
    assert.ok(list.agents.some((a) => a.id === "erc8004:9" && a.source === "community" && a.reputation.average === 80));
    assert.equal((await fetch(`${url}/marketplace?city=bad`)).status, 400);
    const withCity = await (await fetch(`${url}/marketplace?city=${CITY}`)).json();
    assert.equal(withCity.agents.find((a) => a.id === "erc8004:9").hiredInCity, true);
  } finally {
    server.close();
  }
  const bare = createHttpServer({ health: async () => ({ ok: true }) }, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => bare.listen(0, "127.0.0.1", r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${bare.address().port}/marketplace`)).status, 404);
  } finally {
    bare.close();
  }
});

test("with a marketplace contract: applying needs an open listing by the owner, and the listing shows price, stats and the hire call", async () => {
  const fx = fixture({ listings: { 9: [listingOf()] } });
  const m = build(fx, { market: MARKET, ipLimit: 1000, globalLimit: 1000 });
  const applied = await m.apply({ agentId: 9 }, {});
  assert.equal(applied.listed, true);

  const list = await m.list({ city: CITY });
  assert.equal(list.marketplace, MARKET);
  const entry = list.agents.find((a) => a.id === "erc8004:9");
  assert.equal(entry.offers.length, 1);
  assert.deepEqual([entry.offers[0].price, entry.offers[0].period, entry.offers[0].hires, entry.offers[0].hireable], ["250000", 604800, 3, true]);
  assert.deepEqual([entry.pricing.model, entry.pricing.price, entry.pricing.listingId], ["onchain", "250000", "0"]);
  assert.equal(entry.hireVia.function.startsWith("hire("), true);
  assert.equal(entry.hireVia.contract, MARKET);
  assert.equal(entry.hireVia.hook, GUARDIAN);
  assert.equal(entry.hireVia.data, "0x000000000000000000000000887ac9965980f680debd08a30e2fb33ae99f2397", "the city address, ABI encoded, ready for the mayor's call");
});

test("with a marketplace contract: no listing, a closed listing, the wrong capability or someone else's listing are all refused", async () => {
  const ip = { ip: "9.9.9.9" };
  const none = build(fixture({ listings: {} }), { market: MARKET, ipLimit: 1000, globalLimit: 1000 });
  await assert.rejects(() => none.apply({ agentId: 9 }, ip), /list this agent on the AgentMarketplace contract first/);
  for (const bad of [{ active: false }, { capability: CAPABILITY_BY_ROLE[3] }, { seller: "0x00000000000000000000000000000000000000f9" }]) {
    const m = build(fixture({ listings: { 9: [listingOf(bad)] } }), { market: MARKET, ipLimit: 1000, globalLimit: 1000 });
    await assert.rejects(() => m.apply({ agentId: 9 }, ip), /list this agent on the AgentMarketplace contract first/, JSON.stringify(Object.keys(bad)));
  }
});

test("with a marketplace contract: a listing that went stale after the application is shown but not hireable", async () => {
  const listings = { 9: [listingOf()] };
  const fx = fixture({ listings });
  const m = build(fx, { market: MARKET, ipLimit: 1000, globalLimit: 1000 });
  await m.apply({ agentId: 9 }, {});
  listings[9][0].seller = "0x00000000000000000000000000000000000000f9";
  const entry = (await m.list()).agents.find((a) => a.id === "erc8004:9");
  assert.equal(entry.offers[0].hireable, false);
  assert.equal(entry.hireVia, undefined);
  assert.equal(entry.pricing.model, "free", "no live price is promised for a stale listing");
});
