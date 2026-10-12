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
//
// Environment: RELAYER_PRIVATE_KEY (required), MONAD_TESTNET_RPC, FACTORY_ADDRESS, AUSD_FAUCET (set to "" to disable
// /faucet), PORT (default 8787), ALLOWED_ORIGIN (CORS, comma-separated, default http://localhost:3000), TRUST_PROXY=1 behind a proxy such as Railway, MAX_DEPOSIT_ASSETS,
// STYLE_FILE (where city styles are saved, default ./data/styles.json; set it to a volume path in production, set to "" to turn /style off).

import http from "node:http";
import { createPublicClient, createWalletClient, defineChain, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HttpError } from "./guards.mjs";
import { createRelayer } from "./relayer.mjs";
import { createStyleStore } from "./style.mjs";

const DEFAULTS = {
  testnetRpc: "https://testnet-rpc.monad.xyz",
  factory: "0x6765F0C80F6a7D5EC7Af120d12e81628F641508E", // CityFactory, contracts/deployments/monad-testnet.json
  faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C", // Agora AUSD testnet faucet
  styleFile: "./data/styles.json",
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
  return createRelayer({
    publicClient,
    walletClient,
    style,
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
