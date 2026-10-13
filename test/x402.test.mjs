import { test } from "node:test";
import assert from "node:assert/strict";

import { X402_TESTNET, createPaidReports, priceToUnits } from "../src/x402.mjs";
import { agentList } from "../src/agents.mjs";
import { createAgentIdentity } from "../src/erc8004.mjs";
import { createHttpServer } from "../src/server.mjs";

const HUMAS = "0x8Df168681FE3EF206D8a3fE8eC0C003A776aD498";
const CITY = "0x887AC9965980f680dEbd08A30e2FB33aE99F2397";

/** A stand-in for @x402/core's HTTP server: records what the route asks of it and answers as scripted. */
function fakeX402({ verdict = "paid", settle = "ok" } = {}) {
  const calls = { process: 0, settle: 0 };
  const server = {
    async processHTTPRequest() {
      calls.process += 1;
      if (verdict === "unpaid") return { type: "payment-error", response: { status: 402, headers: { "PAYMENT-REQUIRED": "abc" }, body: {} } };
      return { type: "payment-verified", paymentPayload: { p: 1 }, paymentRequirements: { r: 1 } };
    },
    async processSettlement() {
      calls.settle += 1;
      if (settle === "fail") return { success: false, errorReason: "insufficient_funds", headers: {}, response: { status: 402, headers: { "PAYMENT-REQUIRED": "retry" }, body: { error: "settlement failed" } } };
      return { success: true, headers: { "PAYMENT-RESPONSE": "receipt" }, transaction: "0xabc", network: X402_TESTNET.network };
    },
  };
  return { calls, factory: async () => server };
}

const okHumas = (over = {}) => ({ address: HUMAS, info: () => ({ llmProviders: [] }), report: async (city) => ({ status: "ok", city, text: "laporan" }), ...over });

async function serve(relayer) {
  const server = createHttpServer({ health: async () => ({ ok: true }), ...relayer }, { allowedOrigins: ["http://localhost:3000"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("priceToUnits: dollars become AUSD units and bad prices are refused", () => {
  assert.equal(priceToUnits("$0.01"), "10000");
  assert.equal(priceToUnits("$1"), "1000000");
  assert.equal(priceToUnits("0.5"), "500000");
  assert.equal(priceToUnits("$0.000001"), "1");
  for (const bad of ["$0", "free", "-1", "$1e3", ""]) assert.throws(() => priceToUnits(bad), undefined, bad);
});

test("an unpaid request gets the facilitator's 402 and nothing is built or settled", async () => {
  const x = fakeX402({ verdict: "unpaid" });
  let built = 0;
  const humas = okHumas({ report: async () => { built += 1; return { status: "ok" }; } });
  const s = await serve({ humas, x402: createPaidReports({ humas, payTo: HUMAS, httpServerFactory: x.factory }) });
  try {
    const res = await fetch(`${s.url}/paid/report/${CITY}`);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("payment-required"), "abc");
    assert.equal(built, 0);
    assert.equal(x.calls.settle, 0);
  } finally {
    s.close();
  }
});

test("a verified payment builds the report, settles, and returns the receipt header with CORS exposure", async () => {
  const x = fakeX402();
  const humas = okHumas();
  const s = await serve({ humas, x402: createPaidReports({ humas, payTo: HUMAS, price: "$0.01", httpServerFactory: x.factory }) });
  try {
    const res = await fetch(`${s.url}/paid/report/${CITY}?days=3`, { headers: { origin: "http://localhost:3000", "payment-signature": "sig" } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("payment-response"), "receipt");
    assert.match(res.headers.get("access-control-expose-headers"), /payment-response/);
    assert.equal(body.status, "ok");
    assert.equal(body.charged, true);
    assert.deepEqual(body.paid, { price: "$0.01", payTo: HUMAS, transaction: "0xabc", network: "eip155:10143" });
    assert.equal(x.calls.settle, 1);
    const pre = await fetch(`${s.url}/paid/report/${CITY}`, { method: "OPTIONS" });
    assert.match(pre.headers.get("access-control-allow-headers"), /payment-signature/);
  } finally {
    s.close();
  }
});

test("no report, no charge: a city Humas cannot report on is never settled", async () => {
  const x = fakeX402();
  const humas = okHumas({ report: async (city) => ({ status: "not-hired", city }) });
  const s = await serve({ humas, x402: createPaidReports({ humas, payTo: HUMAS, httpServerFactory: x.factory }) });
  try {
    const body = await (await fetch(`${s.url}/paid/report/${CITY}`)).json();
    assert.equal(body.status, "not-hired");
    assert.equal(body.charged, false);
    assert.equal(x.calls.settle, 0, "the signed authorization is never submitted");
  } finally {
    s.close();
  }
});

test("a failed settlement returns the facilitator's 402 instead of the report", async () => {
  const x = fakeX402({ settle: "fail" });
  const humas = okHumas();
  const s = await serve({ humas, x402: createPaidReports({ humas, payTo: HUMAS, httpServerFactory: x.factory }) });
  try {
    const res = await fetch(`${s.url}/paid/report/${CITY}`);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.text, undefined, "no report leaks when payment did not go through");
  } finally {
    s.close();
  }
});

test("a facilitator that is down gives 503 on this route only, and the next request tries again", async () => {
  let attempts = 0;
  const x = fakeX402();
  const factory = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("facilitator down");
    return x.factory();
  };
  const humas = okHumas();
  const s = await serve({ humas, x402: createPaidReports({ humas, payTo: HUMAS, httpServerFactory: factory }) });
  try {
    assert.equal((await fetch(`${s.url}/paid/report/${CITY}`)).status, 503);
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    assert.equal((await fetch(`${s.url}/paid/report/${CITY}`)).status, 200);
  } finally {
    s.close();
  }
});

test("paid-report requests are rate limited per address before they reach the facilitator", async () => {
  const x = fakeX402({ verdict: "unpaid" });
  const humas = okHumas();
  const s = await serve({ humas, x402: createPaidReports({ humas, payTo: HUMAS, httpServerFactory: x.factory }) });
  try {
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await fetch(`${s.url}/paid/report/${CITY}`)).status === 429) limited += 1;
    assert.equal(limited, 5);
    assert.equal(x.calls.process, 20);
  } finally {
    s.close();
  }
});

test("without the x402 module the route does not exist, and the registration file only claims x402 when it is on", async () => {
  const humas = okHumas();
  const s = await serve({ humas });
  try {
    assert.equal((await fetch(`${s.url}/paid/report/${CITY}`)).status, 404);
  } finally {
    s.close();
  }
  const publicClient = { readContract: async () => [] };
  assert.equal(createAgentIdentity({ publicClient, baseUrl: "https://r.example" }).card("humas").x402Support, false);
  const on = createAgentIdentity({ publicClient, baseUrl: "https://r.example", x402Agents: ["humas"] });
  assert.equal(on.card("humas").x402Support, true);
  assert.ok(on.card("humas").services.some((s) => s.name === "x402-report"));
  assert.equal(on.card("analis").x402Support, false);
  const info = createPaidReports({ humas, payTo: HUMAS, httpServerFactory: fakeX402().factory }).info();
  assert.equal(info.units, "10000");
  assert.equal(agentList({ humas, x402: { info: () => info } }).agents.find((a) => a.id === "humas").x402.route, "GET /paid/report/:city?days=7");
  assert.equal(agentList({ humas }).agents.find((a) => a.id === "humas").x402, null);
});
