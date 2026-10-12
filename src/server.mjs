#!/usr/bin/env node
// HTTP wrapper for the relayer.
//
//   RELAYER_PRIVATE_KEY=0x… node src/server.mjs
//
//   GET  /health
//   POST /deposit   { vault, owner, assets, deadline, v, r, s }   -> { hash, status, shares, sharesOwner }
//   POST /withdraw  { vault, owner, shares, deadline, v, r, s }   -> { hash, status, assets, receiver }
//   POST /gas-drip  { address }                                   -> { hash, recipient, amountWei }   (testnet MON for mayors)
//   POST /faucet    { address }                                   -> { hash, status, recipient }   (testnet AUSD)
//   POST /style     { vault, code, nonce, signature }             -> { vault, code, nonce }   (mayor-signed EIP-712 CityStyle, see src/style.mjs)
//   GET  /style/:vault                                            -> { code, nonce }
//   GET  /analyst                                                 -> { address, role } (the Analyst bot; needs ANALYST_PRIVATE_KEY)
//   GET  /proposals/:city                                         -> the Analyst's proposals with their reasons and on-chain status
//   POST /analyst/run  { city }                                   -> look at one city now (the mayor still has to approve any proposal)
//
// Environment: RELAYER_PRIVATE_KEY (required), MONAD_TESTNET_RPC, FACTORY_ADDRESS, AUSD_FAUCET (set to "" to disable
// /faucet), PORT (default 8787), ALLOWED_ORIGIN (CORS, comma-separated, default http://localhost:3000), TRUST_PROXY=1 behind a proxy such as Railway, MAX_DEPOSIT_ASSETS,
// ANALYST_PRIVATE_KEY (turns the Analyst on), PROPOSALS_FILE (default ./data/proposals.json), ANTHROPIC_API_KEY and/or XKIRO_API_KEY (optional, they write the reasons; Anthropic is tried first), ANALYST_LLM=0 to ignore the keys, ANALYST_LLM_MODEL, XKIRO_MODEL,
// STYLE_FILE (where city styles are saved, default ./data/styles.json; set it to a volume path in production, set to "" to turn /style off).

import http from "node:http";
import { createPublicClient, createWalletClient, defineChain, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HttpError } from "./guards.mjs";
import { createRelayer } from "./relayer.mjs";
import { createStyleStore } from "./style.mjs";
import { createAnalyst, createPlanStore } from "./analyst.mjs";

const DEFAULTS = {
  testnetRpc: "https://testnet-rpc.monad.xyz",
  factory: "0x6765F0C80F6a7D5EC7Af120d12e81628F641508E", // CityFactory, contracts/deployments/monad-testnet.json
  faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C", // Agora AUSD testnet faucet
  styleFile: "./data/styles.json",
  proposalsFile: "./data/proposals.json",
  guardian: "0x083899bEE8138E5f951db568926393FDb1F418A2", // CityGuardian, contracts/deployments/monad-testnet.json
  feed: "0x707A675DDc976B0E9C6B520Dbd0326204F30d540", // ApyFeed
  sourceId: "0x71809e1e29dc09210f61029b6e5b4f037fb332bdf7caa16cf9362c78c500926d", // morpho-grove-steakhouse-high-yield-ausd-mainnet
  asset: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", // AUSD testnet
};

export function buildRelayerFromEnv(env = process.env) {
  const key = env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error("RELAYER_PRIVATE_KEY is not set");
  const rpc = env.MONAD_TESTNET_RPC || DEFAULTS.testnetRpc;
  const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain, transport: viemHttp(rpc) });
  const walletClient = createWalletClient({ account, chain, transport: viemHttp(rpc) });
  const factory = env.FACTORY_ADDRESS || DEFAULTS.factory;
  const styleFile = env.STYLE_FILE === undefined ? DEFAULTS.styleFile : env.STYLE_FILE;
  const style = styleFile ? createStyleStore({ publicClient, factory, file: styleFile }) : null;
  let analyst = null;
  if (env.ANALYST_PRIVATE_KEY) {
    const analystAccount = privateKeyToAccount(env.ANALYST_PRIVATE_KEY);
    const proposalsFile = env.PROPOSALS_FILE === undefined ? DEFAULTS.proposalsFile : env.PROPOSALS_FILE;
    analyst = createAnalyst({
      publicClient,
      walletClient: createWalletClient({ account: analystAccount, chain, transport: viemHttp(rpc) }),
      store: createPlanStore({ file: proposalsFile || undefined }),
      // Reasons are written by Anthropic first and by the xKiro gateway if that fails; neither key is required.
      llm:
        env.ANALYST_LLM === "0"
          ? null
          : [
              env.ANTHROPIC_API_KEY && { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, model: env.ANALYST_LLM_MODEL || undefined },
              env.XKIRO_API_KEY && { provider: "xkiro", apiKey: env.XKIRO_API_KEY, model: env.XKIRO_MODEL || undefined },
            ].filter(Boolean),
      config: { guardian: env.GUARDIAN_ADDRESS || DEFAULTS.guardian, factory, feed: env.FEED_ADDRESS || DEFAULTS.feed, sourceId: env.APY_SOURCE_ID || DEFAULTS.sourceId, asset: env.AUSD_ADDRESS || DEFAULTS.asset },
    });
  }
  return createRelayer({
    publicClient,
    walletClient,
    style,
    analyst,
    config: {
      factory,
      faucet: env.AUSD_FAUCET === undefined ? DEFAULTS.faucet : env.AUSD_FAUCET || null,
      maxAssets: env.MAX_DEPOSIT_ASSETS ? BigInt(env.MAX_DEPOSIT_ASSETS) : undefined,
    },
  });
}

async function readJson(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/** Origins allowed by CORS: a comma-separated list (or "*"). Defaults to the local dev frontend. */
export function parseAllowedOrigins(value) {
  const list = String(value || "http://localhost:3000").split(",").map((v) => v.trim()).filter(Boolean);
  return list;
}

/** The client address: the first X-Forwarded-For entry when behind a trusted proxy (Railway), else the socket's. */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || undefined;
}

export function createHttpServer(relayer, { allowedOrigins = ["http://localhost:3000"], trustProxy = false } = {}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowOrigin = allowedOrigins.includes("*") ? "*" : origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    const send = (status, payload, extraHeaders = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": allowOrigin,
        vary: "origin",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        ...extraHeaders,
      });
      res.end(JSON.stringify(payload));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const ctx = { ip: clientIp(req, trustProxy) };
      if (req.method === "OPTIONS") return send(204, {});
      if (req.method === "GET" && (path === "/health" || path === "/")) return send(200, await relayer.health());
      if (req.method === "POST" && path === "/deposit") return send(200, await relayer.deposit(await readJson(req), ctx));
      if (req.method === "POST" && path === "/withdraw") return send(200, await relayer.withdraw(await readJson(req), ctx));
      if (req.method === "POST" && path === "/gas-drip") return send(200, await relayer.gasDrip(await readJson(req), ctx));
      if (req.method === "POST" && path === "/faucet") return send(200, await relayer.faucet(await readJson(req), ctx));
      if (relayer.style && req.method === "POST" && path === "/style") return send(200, await relayer.style.set(await readJson(req), ctx));
      if (relayer.style && req.method === "GET" && path.startsWith("/style/")) return send(200, relayer.style.get(decodeURIComponent(path.slice("/style/".length))));
      if (relayer.analyst && req.method === "GET" && path === "/analyst") return send(200, relayer.analyst.info());
      if (relayer.analyst && req.method === "GET" && path.startsWith("/proposals/")) return send(200, await relayer.analyst.list(decodeURIComponent(path.slice("/proposals/".length))));
      if (relayer.analyst && req.method === "POST" && path === "/analyst/run") return send(200, await relayer.analyst.run(await readJson(req), ctx));
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) {
        const headers = e.extra?.retryAfterSeconds ? { "retry-after": String(e.extra.retryAfterSeconds) } : {};
        return send(e.status, { error: e.message, ...e.extra }, headers);
      }
      console.error("unexpected error:", e?.shortMessage || e?.message || e);
      return send(500, { error: "internal error" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const relayer = buildRelayerFromEnv();
  const port = Number(process.env.PORT || 8787);
  createHttpServer(relayer, { allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGIN), trustProxy: process.env.TRUST_PROXY === "1" }).listen(port, "0.0.0.0", () => {
    console.log(`relayer listening on :${port} (factory ${relayer.config.factory})`);
  });
}
