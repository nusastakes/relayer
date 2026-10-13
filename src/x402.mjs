// Pay-per-report with x402 (PRD R23, backlog BX.5), on Monad testnet.
//
// `GET /paid/report/:city?days=7` returns the same report as the free `GET /report/:city`, but the Humas agent is paid for
// it: the caller signs an EIP-3009 `transferWithAuthorization` for the price in AUSD, the Monad facilitator verifies it,
// and after the report is built the facilitator settles it (and pays the gas), moving the AUSD to Humas's address. The
// caller needs AUSD but no MON.
//
// Rules this module keeps:
//  * the payment is settled only after a report was actually produced, so an unknown city or a mayor who never hired the
//    Humas costs nothing (the signed authorization is simply never submitted);
//  * if settlement fails, the caller gets the facilitator's 402 and not the report;
//  * the facilitator is a third party, so payment headers are rate limited per address before they reach it, and a
//    facilitator that is down gives 503 on this route only.

import { HttpError, createRateLimiter } from "./guards.mjs";

export const X402_TESTNET = {
  network: "eip155:10143",
  facilitator: "https://x402-facilitator.molandak.org",
  asset: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", // AUSD testnet, 6 decimals
  assetDomain: { name: "Agora Dollar", version: "1" }, // its EIP-712 domain, read from eip712Domain() on 13 Oct
  decimals: 6,
};

/** "$0.01" -> "10000" (smallest AUSD units). */
export function priceToUnits(price, decimals = X402_TESTNET.decimals) {
  const m = /^\$?([0-9]+)(?:\.([0-9]{1,18}))?$/.exec(String(price).trim());
  if (!m) throw new Error(`price must look like $0.01, got ${price}`);
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0").slice(0, decimals) || "0");
  if (units <= 0n) throw new Error("price must be positive");
  return units.toString();
}

/** Adapts a node:http request to the shape @x402/core wants. */
function adapterFor(req, url) {
  return {
    getHeader: (name) => {
      const v = req.headers[String(name).toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    },
    getMethod: () => req.method,
    getPath: () => url.pathname,
    getUrl: () => url.href,
    getAcceptHeader: () => req.headers.accept ?? "",
    getUserAgent: () => req.headers["user-agent"] ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams),
    getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
  };
}

/**
 * @param {{humas: {report: Function}, payTo: string, price?: string, publicUrl?: string, now?: () => number, config?: typeof X402_TESTNET, httpServerFactory?: () => Promise<any>}} options
 * `httpServerFactory` exists so tests can swap the real x402 server for a fake one.
 */
export function createPaidReports({ humas, payTo, price = "$0.01", publicUrl = "", now = () => Date.now(), config = X402_TESTNET, httpServerFactory = null }) {
  if (!humas) throw new Error("paid reports need the Humas agent");
  const units = priceToUnits(price, config.decimals);
  const perIp = createRateLimiter({ windowMs: 60_000, max: 20, now });
  let ready = null;

  async function build() {
    const [{ x402ResourceServer, x402HTTPResourceServer, HTTPFacilitatorClient }, { ExactEvmScheme }] = await Promise.all([import("@x402/core/server"), import("@x402/evm/exact/server")]);
    const scheme = new ExactEvmScheme();
    // AUSD is not in the SDK's token table, so say how to turn a dollar price into AUSD units.
    scheme.registerMoneyParser(async (_amount, network) => (network === config.network ? { amount: units, asset: config.asset, extra: { ...config.assetDomain } } : null));
    const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitator }));
    resourceServer.register(config.network, scheme);
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "GET /paid/report/:city": {
        accepts: { scheme: "exact", network: config.network, payTo, price },
        description: "Weekly city report in Indonesian, written by the Humas agent",
        mimeType: "application/json",
      },
    });
    await httpServer.initialize();
    return httpServer;
  }
  /** Built on first use and retried after a failure, so a facilitator outage never stops the relayer from starting. */
  const server = () => (ready ??= (httpServerFactory ?? build)().catch((e) => {
    ready = null;
    throw e;
  }));

  return {
    enabled: true,
    info: () => ({ network: config.network, asset: config.asset, payTo, price, units, facilitator: config.facilitator, route: "GET /paid/report/:city?days=7" }),

    /**
     * Handles `GET /paid/report/:city`. Writes the response itself (the settlement headers must be added) and returns
     * nothing; throws HttpError for the ordinary failures.
     */
    async handle(req, res, ctx, cors = {}) {
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many paid-report requests from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      const url = new URL(req.url, publicUrl || "http://localhost");
      let http;
      try {
        http = await server();
      } catch (e) {
        console.error("x402 server could not start:", e?.message || e);
        throw new HttpError(503, "the payment facilitator is not reachable, try again shortly");
      }
      const write = (status, headers, body) => {
        const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json", ...cors, ...headers });
        res.end(text);
      };

      const context = { adapter: adapterFor(req, url), path: url.pathname, method: req.method, paymentHeader: req.headers["payment-signature"] ?? req.headers["x-payment"] };
      const result = await http.processHTTPRequest(context);
      if (result.type === "no-payment-required") throw new HttpError(404, "not found");
      if (result.type === "payment-error") return write(result.response.status, result.response.headers, result.response.body ?? {});

      // Paid and verified, nothing settled yet. Build the report first; any failure here propagates before money moves.
      const city = decodeURIComponent(url.pathname.slice("/paid/report/".length));
      const report = await humas.report(city, url.searchParams.get("days") ?? undefined, ctx);
      if (report?.status !== "ok") return write(200, {}, { ...report, charged: false });

      const settled = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: context }, undefined, result.beforeHandlerSettlement);
      if (!settled.success) return write(settled.response.status, settled.response.headers, settled.response.body ?? {});
      return write(200, settled.headers, { ...report, charged: true, paid: { price, payTo, transaction: settled.transaction ?? null, network: settled.network ?? config.network } });
    },
  };
}
