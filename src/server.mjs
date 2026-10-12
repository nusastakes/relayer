#!/usr/bin/env node
// HTTP wrapper for the relayer.
//
//   RELAYER_PRIVATE_KEY=0x… node src/server.mjs
//
//   GET  /health
//   POST /deposit   { vault, owner, assets, deadline, v, r, s }   -> { hash, status, shares, sharesOwner }
//   POST /faucet    { address }                                   -> { hash, status, recipient }   (testnet AUSD)
//
// Environment: RELAYER_PRIVATE_KEY (required), MONAD_TESTNET_RPC, FACTORY_ADDRESS, AUSD_FAUCET (set to "" to disable
// /faucet), PORT (default 8787), ALLOWED_ORIGIN (CORS, default http://localhost:3000), MAX_DEPOSIT_ASSETS.

import http from "node:http";
import { createPublicClient, createWalletClient, defineChain, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HttpError } from "./guards.mjs";
import { createRelayer } from "./relayer.mjs";

const DEFAULTS = {
  testnetRpc: "https://testnet-rpc.monad.xyz",
  factory: "0xA54D964a4bF13be1E5AF05D5c7290f275f13B24C", // CityFactory, contracts/deployments/monad-testnet.json
  faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C", // Agora AUSD testnet faucet
};

export function buildRelayerFromEnv(env = process.env) {
  const key = env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error("RELAYER_PRIVATE_KEY is not set");
  const rpc = env.MONAD_TESTNET_RPC || DEFAULTS.testnetRpc;
  const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain, transport: viemHttp(rpc) });
  const walletClient = createWalletClient({ account, chain, transport: viemHttp(rpc) });
  return createRelayer({
    publicClient,
    walletClient,
    config: {
      factory: env.FACTORY_ADDRESS || DEFAULTS.factory,
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

export function createHttpServer(relayer, { allowedOrigin = "http://localhost:3000" } = {}) {
  return http.createServer(async (req, res) => {
    const send = (status, payload, extraHeaders = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        ...extraHeaders,
      });
      res.end(JSON.stringify(payload));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "OPTIONS") return send(204, {});
      if (req.method === "GET" && path === "/health") return send(200, await relayer.health());
      if (req.method === "POST" && path === "/deposit") return send(200, await relayer.deposit(await readJson(req)));
      if (req.method === "POST" && path === "/faucet") return send(200, await relayer.faucet(await readJson(req)));
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
  createHttpServer(relayer, { allowedOrigin: process.env.ALLOWED_ORIGIN || undefined }).listen(port, () => {
    console.log(`relayer listening on :${port} (factory ${relayer.config.factory})`);
  });
}
