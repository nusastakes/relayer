import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ERC8004_TESTNET, STAFF, createAgentIdentity } from "../src/erc8004.mjs";
import { agentList } from "../src/agents.mjs";
import { createHttpServer } from "../src/server.mjs";

const BASE = "https://relayer.example";
const CLIENT_A = "0x00000000000000000000000000000000000000a1";
const CLIENT_B = "0x00000000000000000000000000000000000000b2";
const registry = `eip155:10143:${ERC8004_TESTNET.identityRegistry}`;
const deployments = { agents: { analis: { agentId: "7", owner: "0x00000000000000000000000000000000000000c3", agentURI: `${BASE}/agents/analis/card.json` } } };

/** A client that answers the three reads the module makes. */
function fakeClient({ clients = [CLIENT_A], summary = [1n, 90n, 0], rows = {} } = {}) {
  const calls = [];
  return {
    calls,
    async readContract({ functionName, args }) {
      calls.push(functionName);
      if (functionName === "getClients") return clients;
      if (functionName === "getSummary") return summary;
      if (functionName === "getLastIndex") return BigInt(Object.keys(rows[args[1]] ?? {}).length);
      if (functionName === "readFeedback") return rows[args[1]][Number(args[2])];
      throw new Error(`unexpected ${functionName}`);
    },
  };
}

test("card: follows the ERC-8004 registration format and names the on-chain registration once it exists", () => {
  const identity = createAgentIdentity({ publicClient: fakeClient(), baseUrl: `${BASE}/`, deployments });
  const card = identity.card("analis");
  assert.equal(card.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(card.name, STAFF.analis.name);
  assert.deepEqual(card.registrations, [{ agentId: 7, agentRegistry: registry }]);
  assert.ok(card.services.every((s) => s.endpoint.startsWith(BASE) && !s.endpoint.startsWith(`${BASE}//`)), "trailing slash in the base URL does not double up");
  assert.deepEqual(card.supportedTrust, ["reputation"]);
  assert.equal(card.x402Support, false);
  // An agent that was never registered still has a card, with no registration to claim.
  assert.deepEqual(identity.card("humas").registrations, []);
  assert.equal(identity.card("nobody"), null);
});

test("entry: only registered staff have an ERC-8004 identity", () => {
  const identity = createAgentIdentity({ publicClient: fakeClient(), baseUrl: BASE, deployments });
  assert.deepEqual(identity.entry("analis"), { agentId: "7", owner: "0x00000000000000000000000000000000000000c3", agentURI: `${BASE}/agents/analis/card.json`, registry });
  assert.equal(identity.entry("satpam"), null);
  const empty = createAgentIdentity({ publicClient: fakeClient(), baseUrl: BASE, file: "/nonexistent/erc8004.json" });
  assert.equal(empty.entry("analis"), null, "a missing file means unregistered, not a crash");
});

test("reputation: averages over every client, scaled by the decimals the registry reports", async () => {
  const identity = createAgentIdentity({ publicClient: fakeClient({ clients: [CLIENT_A, CLIENT_B], summary: [2n, 9550n, 2] }), baseUrl: BASE, deployments });
  assert.deepEqual(await identity.reputation("7"), { count: 2, average: 95.5, clients: 2 });
  const none = createAgentIdentity({ publicClient: fakeClient({ clients: [] }), baseUrl: BASE, deployments });
  assert.deepEqual(await none.reputation(7n), { count: 0, average: null, clients: 0 });
});

test("feedback: lists each client's rows newest first and respects the limit", async () => {
  const rows = { [CLIENT_A]: { 1: [80n, 0, "a", "x", false], 2: [90n, 0, "b", "y", true] } };
  const identity = createAgentIdentity({ publicClient: fakeClient({ rows }), baseUrl: BASE, deployments });
  const all = await identity.feedback(7);
  assert.deepEqual(all.map((r) => [r.index, r.value, r.tag1, r.revoked]), [[2, 90, "b", true], [1, 80, "a", false]]);
  assert.equal((await identity.feedback(7, 1)).length, 1);
});

test("agentList: staff carry their ERC-8004 identity, or null before they register", () => {
  const identity = createAgentIdentity({ publicClient: fakeClient(), baseUrl: BASE, deployments });
  const list = agentList({ identity });
  assert.equal(list.erc8004.agentRegistry, registry);
  assert.deepEqual(list.agents.map((a) => [a.id, a.erc8004?.agentId ?? null]), [["satpam", null], ["analis", "7"], ["humas", null]]);
  assert.equal(agentList({}).erc8004, null);
});

test("the deployments file shipped with the relayer registers all three staff in the testnet registry", () => {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../deployments/erc8004-testnet.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.identityRegistry, ERC8004_TESTNET.identityRegistry);
  assert.equal(data.reputationRegistry, ERC8004_TESTNET.reputationRegistry);
  const identity = createAgentIdentity({ publicClient: fakeClient(), baseUrl: BASE, deployments: data });
  for (const id of Object.keys(STAFF)) {
    assert.match(identity.entry(id)?.agentId ?? "", /^[0-9]+$/, `${id} has an agent id`);
    assert.equal(identity.card(id).registrations.length, 1);
  }
  assert.equal(new Set(Object.values(data.agents).map((a) => a.agentId)).size, 3, "three distinct agents");
  assert.ok(data.feedback.every((f) => f.tag2 === "demo-seed"), "seeded ratings stay labelled as demo");
});

test("HTTP: card.json is served, unknown staff 404, and /agents adds cached reputation without ever failing on a bad read", async () => {
  const good = createAgentIdentity({ publicClient: fakeClient({ summary: [1n, 90n, 0] }), baseUrl: BASE, deployments });
  const relayer = { identity: good, health: async () => ({ ok: true }) };
  const server = createHttpServer(relayer, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const card = await (await fetch(`${url}/agents/analis/card.json`)).json();
    assert.equal(card.registrations[0].agentId, 7);
    assert.equal((await fetch(`${url}/agents/nobody/card.json`)).status, 404);
    const agents = await (await fetch(`${url}/agents`)).json();
    const analis = agents.agents.find((a) => a.id === "analis");
    assert.deepEqual(analis.erc8004.reputation, { count: 1, average: 90, clients: 1 });
    assert.equal(agents.agents.find((a) => a.id === "satpam").erc8004, null);
  } finally {
    server.close();
  }

  const broken = createAgentIdentity({ publicClient: { readContract: async () => { throw new Error("rpc down"); } }, baseUrl: BASE, deployments });
  const server2 = createHttpServer({ identity: broken, health: async () => ({ ok: true }) }, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server2.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server2.address().port}/agents`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).agents.find((a) => a.id === "analis").erc8004.reputation, null);
  } finally {
    server2.close();
  }
});
