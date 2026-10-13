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
//   PUT  /map/:uri { vault, map, signature }                      -> { uri, mapHash, ... }   (OpenStreetMap city map cache, mayor-signed EIP-712 CityMap, first write wins, see src/maps.mjs)
//   GET  /map/:uri                                                -> the cached map (Cache-Control: public, max-age=86400), 404 if none
//   PUT  /book { owner, id, ciphertext, nonce, signature }        -> { hash, ... }   (sealed strategy book: ciphertext only, see src/book.mjs)
//   GET  /book/:owner  and  GET /book/:owner/:id                  -> entries (ciphertext on the second)
//   GET  /leaderboard, /metrics, /index, /economy                 -> cities ranked by return with live TVL and indexed residents; platform numbers; indexer progress; DefiLlama fees per sector
//   GET  /score/:city                                             -> the city's score from its services: variety, count, wealth, 7-day income and outside traffic (see score.mjs)
//   GET  /history/:city?days=7                                    -> the city's events of the last 1..30 days, newest first, with traffic totals (see indexer.history)
//   GET  /catalog                                                 -> { services, kinds }: the protocol services a mayor can place (live APY/TVL, adapter impl) and the CityServices kinds
//   GET  /services                                                -> recent actions of the market resolver and the fee releaser
//   GET  /tuning/preview?service=&loopX100=&takeRewards=&rangeBps=&centerPriceE8=  -> effective APY of a service under a tuning (see tuning.mjs)
//   GET  /tuning/:adapter                                         -> a TunedMirrorAdapter's tuning, effective APY and what the feed holds
//   GET  /tuned                                                   -> recent writes of the tuned keeper
//   GET  /rules/presets                                           -> rule templates (toggles) a mayor can enable
//   GET  /rules/:city  and  GET /rules/:city/preview              -> the mayor's rules with the autopilot status; what they would do now (dry run)
//   PUT  /rules/:city { vault, rulesJson, nonce, signature }      -> mayor-signed EIP-712 CityRules (see autopilot.mjs)
//   GET  /report/:city?days=7                                     -> the Humas's report in Indonesian (the mayor must have hired it)
//   GET  /agents                                                  -> the AI staff a mayor can hire (Satpam, Analis, Humas)
//   GET  /analyst                                                 -> { address, role } (the Analyst bot; needs ANALYST_PRIVATE_KEY)
//   GET  /proposals/:city                                         -> the Analyst's proposals with their reasons and on-chain status
//   POST /analyst/run  { city }                                   -> look at one city now (the mayor still has to approve any proposal)
//
// Environment: RELAYER_PRIVATE_KEY (required), MONAD_TESTNET_RPC, FACTORY_ADDRESS, AUSD_FAUCET (set to "" to disable
// /faucet), PORT (default 8787), ALLOWED_ORIGIN (CORS, comma-separated, default http://localhost:3000), TRUST_PROXY=1 behind a proxy such as Railway, MAX_DEPOSIT_ASSETS,
// INDEX_FILE (default ./data/index.json), INDEXER=0 / ECONOMY=0 to turn those off, INDEX_RANGE (logs per request, default 100; some RPCs allow 10000), INDEX_RPC (a separate RPC for getLogs only, e.g. Envio HyperRPC), INDEX_START_BLOCK, HUMAS_ADDRESS (turns the Humas on),
// BOOK_FILE (default ./data/book.json, "" turns /book off), ANALYST_PRIVATE_KEY (turns the Analyst on), PROPOSALS_FILE (default ./data/proposals.json), ANTHROPIC_API_KEY and/or XKIRO_API_KEY (optional, they write the reasons; Anthropic is tried first), ANALYST_LLM=0 to ignore the keys, ANALYST_LLM_MODEL, XKIRO_MODEL,
// STYLE_FILE (where city styles are saved, default ./data/styles.json; set it to a volume path in production, set to "" to turn /style off),
// MAPS_DIR (where cached city maps are saved, default ./data/maps; set it to a volume path in production, set to "" to turn /map off), MIRROR_ADAPTER_IMPL (the MirrorYieldAdapter implementation the factory allows, shown by /config),
// CITY_SERVICES and CITY_SERVICES_FROM_BLOCK (the CityServices contract and its deploy block: indexed for /history and shown by /config),
// CATALOG_IMPLS_FILE (adapter implementation per catalog service, default src/catalog-impls.json), CATALOG=0 to turn /catalog off,
// MONAD_MAINNET_RPC (reads the primary vault's TVL for /catalog), HISTORY_HIRES=0 to leave staff hires out of the index,
// TUNED_IMPLS_FILE (TunedMirrorAdapter implementation per service, default src/catalog-tuned.json), AUTOPILOT_PRIVATE_KEY
// (the autopilot's own key; without it rules can be stored but nothing runs), RULES_FILE (default ./data/rules.json).

import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, fallback, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HttpError, createMemo, createRateLimiter } from "./guards.mjs";
import { createRelayer, factoryAbi } from "./relayer.mjs";
import { createStyleStore } from "./style.mjs";
import { createMapStore } from "./maps.mjs";
import { createBookStore } from "./book.mjs";
import { createEconomy } from "./economy.mjs";
import { createHumas } from "./humas.mjs";
import { createIndexer } from "./indexer.mjs";
import { agentList } from "./agents.mjs";
import { createAnalyst, createPlanStore } from "./analyst.mjs";
import { createAgentIdentity } from "./erc8004.mjs";
import { createPaidReports } from "./x402.mjs";
import { createMarketplace } from "./marketplace.mjs";
import { createWatchdog } from "./watchdog.mjs";
import { SEEDS, createCatalog, sharedYields } from "./catalog.mjs";
import { createScorer } from "./score.mjs";
import { createServiceJobs } from "./services.mjs";
import { writeSource } from "./keeper.mjs";
import { createMarketData, effectiveApy, knobsFor, tuningJson } from "./tuning.mjs";
import { createTunedKeeper } from "./tuned.mjs";
import { createAutopilot } from "./autopilot.mjs";
import { loadImpls, sourceIdOf } from "./catalog.mjs";

const DEFAULTS = {
  testnetRpc: "https://testnet-rpc.monad.xyz",
  testnetRpcFallbacks: "https://rpc.ankr.com/monad_testnet,https://monad-testnet.drpc.org",
  factory: "0xDC9A322E95E7d9214fA794D39534a15B4aB3d9fF", // CityFactory, contracts/deployments/monad-testnet.json
  faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C", // Agora AUSD testnet faucet
  styleFile: "./data/styles.json",
  mapsDir: "./data/maps",
  proposalsFile: "./data/proposals.json",
  bookFile: "./data/book.json",
  indexFile: "./data/index.json",
  rulesFile: "./data/rules.json",
  erc8004File: "./deployments/erc8004-testnet.json",
  marketplaceFile: "./data/marketplace.json",
  publicUrl: "https://relayer-production-39e1.up.railway.app", // where the ERC-8004 registration files are served
  factoryDeployBlock: 70670656, // block of the v3 CityFactory deployment, where the indexer starts
  guardian: "0x74F881Ec300DfD1BfD26b4c0392f713fc775E7B9", // CityGuardian, contracts/deployments/monad-testnet.json
  market: "0x241E3f8f02C53e075794989b9E7BD9832e539D29", // AgentMarketplace (contracts v3)
  feed: "0x3328AEbB57Ee0bc8d2C7f68468dEe6B9b50926b5", // ApyFeed
  reserve: "0x40e194d12BC3F6a6b26E8B7808f749c88281Ef96", // YieldReserve
  mirrorImpl: "0x156fDb80Bd936f1CF1d45A1a167B660A82043080", // MirrorYieldAdapter implementation the factory allows (clones of it are the cities' adapters)
  sourceId: "0x71809e1e29dc09210f61029b6e5b4f037fb332bdf7caa16cf9362c78c500926d", // morpho-grove-steakhouse-high-yield-ausd-mainnet
  asset: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", // AUSD testnet
  mainnetRpc: "https://rpc.monad.xyz",
  primaryVault: "0x32841A8511D5c2c5b253f45668780B99139e476D", // Morpho Grove x Steakhouse High Yield AUSD on mainnet, the primary catalog service
};

export function buildRelayerFromEnv(env = process.env) {
  const key = env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error("RELAYER_PRIVATE_KEY is not set");
  const rpc = env.MONAD_TESTNET_RPC || DEFAULTS.testnetRpc;
  const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const account = privateKeyToAccount(key);
  // The public testnet RPC drops requests when the indexer, keepers and autopilot run at once; reads and writes fall back to
  // other public endpoints (MONAD_TESTNET_RPC_FALLBACKS, comma-separated) so a refused request is retried elsewhere.
  const fallbacks = (env.MONAD_TESTNET_RPC_FALLBACKS ?? DEFAULTS.testnetRpcFallbacks).split(",").map((u) => u.trim()).filter((u) => /^https:\/\//.test(u) && u !== rpc);
  const transport = () => (fallbacks.length ? fallback([viemHttp(rpc), ...fallbacks.map((u) => viemHttp(u))], { rank: false, retryCount: 2 }) : viemHttp(rpc));
  const publicClient = createPublicClient({ chain, transport: transport() });
  const walletClient = createWalletClient({ account, chain, transport: transport() });
  const factory = env.FACTORY_ADDRESS || DEFAULTS.factory;
  const styleFile = env.STYLE_FILE === undefined ? DEFAULTS.styleFile : env.STYLE_FILE;
  const style = styleFile ? createStyleStore({ publicClient, factory, file: styleFile }) : null;
  const mapsDir = env.MAPS_DIR === undefined ? DEFAULTS.mapsDir : env.MAPS_DIR;
  const maps = mapsDir ? createMapStore({ publicClient, factory, dir: mapsDir }) : null;
  // Staff text (Analis reasons, Humas reports) is written by Anthropic first and by the xKiro gateway if that fails; neither key is required.
  const llm =
    env.ANALYST_LLM === "0"
      ? []
      : [
          env.ANTHROPIC_API_KEY && { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, model: env.ANALYST_LLM_MODEL || undefined },
          env.XKIRO_API_KEY && { provider: "xkiro", apiKey: env.XKIRO_API_KEY, model: env.XKIRO_MODEL || undefined },
        ].filter(Boolean);
  let analyst = null;
  if (env.ANALYST_PRIVATE_KEY) {
    const analystAccount = privateKeyToAccount(env.ANALYST_PRIVATE_KEY);
    const proposalsFile = env.PROPOSALS_FILE === undefined ? DEFAULTS.proposalsFile : env.PROPOSALS_FILE;
    analyst = createAnalyst({
      publicClient,
      walletClient: createWalletClient({ account: analystAccount, chain, transport: transport() }),
      store: createPlanStore({ file: proposalsFile || undefined }),
      llm,
      config: { guardian: env.GUARDIAN_ADDRESS || DEFAULTS.guardian, factory, feed: env.FEED_ADDRESS || DEFAULTS.feed, sourceId: env.APY_SOURCE_ID || DEFAULTS.sourceId, asset: env.AUSD_ADDRESS || DEFAULTS.asset },
    });
  }
  const indexFile = env.INDEX_FILE === undefined ? DEFAULTS.indexFile : env.INDEX_FILE;
  const cityServices = /^0x[0-9a-fA-F]{40}$/.test(env.CITY_SERVICES || "") ? env.CITY_SERVICES : null;
  const startBlock = env.INDEX_START_BLOCK || DEFAULTS.factoryDeployBlock;
  const indexer =
    env.INDEXER === "0"
      ? null
      : createIndexer({
          publicClient,
          // INDEX_RPC: an RPC used only for getLogs, for example Envio HyperRPC (https://monad-testnet.rpc.hypersync.xyz/<token>) with a larger INDEX_RANGE.
          logsClient: env.INDEX_RPC ? createPublicClient({ chain, transport: viemHttp(env.INDEX_RPC) }) : undefined,
          file: indexFile || undefined,
          config: {
            factory,
            startBlock,
            range: env.INDEX_RANGE ? Number(env.INDEX_RANGE) : 100,
            // Staff hires (paid through the marketplace, granted by the guardian) and the city services count as city traffic.
            ...(env.HISTORY_HIRES === "0" ? {} : { guardian: env.GUARDIAN_ADDRESS || DEFAULTS.guardian, market: env.MARKETPLACE_ADDRESS || DEFAULTS.market }),
            ...(cityServices ? { services: cityServices, servicesFromBlock: env.CITY_SERVICES_FROM_BLOCK || startBlock } : {}),
          },
        });
  const economy = env.ECONOMY === "0" ? null : createEconomy();
  const bookFile = env.BOOK_FILE === undefined ? DEFAULTS.bookFile : env.BOOK_FILE;
  // Only a mayor or a depositor of a real city may store sealed-book entries (a fresh key proves nothing); without the
  // indexer there is no way to tell, so the store stays on but relies on its byte caps alone.
  const book = bookFile ? createBookStore({ file: bookFile, canWrite: indexer ? (owner) => indexer.isParticipant(owner) : undefined }) : null;
  const humas =
    env.HUMAS_ADDRESS && indexer
      ? createHumas({ publicClient, indexer, address: env.HUMAS_ADDRESS, llm, analystStore: analyst?.store ?? null, bookStore: book, config: { guardian: env.GUARDIAN_ADDRESS || DEFAULTS.guardian } })
      : null;
  // Pay-per-report with x402 (testnet facilitator); needs the Humas agent. Off with X402=0.
  const x402 = env.X402 === "0" || !humas ? null : createPaidReports({ humas, payTo: env.HUMAS_ADDRESS, price: env.X402_PRICE || "$0.01", publicUrl: env.PUBLIC_URL || DEFAULTS.publicUrl });
  // ERC-8004 identity of the staff (testnet registries). Off with ERC8004=0; agents show as unregistered if the file is missing.
  const identity = env.ERC8004 === "0" ? null : createAgentIdentity({ publicClient, file: env.ERC8004_FILE === undefined ? DEFAULTS.erc8004File : env.ERC8004_FILE || null, baseUrl: env.PUBLIC_URL || DEFAULTS.publicUrl, x402Agents: x402 ? ["humas"] : [], x402Price: env.X402_PRICE || "$0.01" });
  // The staff exchange: team agents plus verified third-party ERC-8004 agents. Needs the ERC-8004 identity. Off with MARKETPLACE=0.
  const guardianAddress = env.GUARDIAN_ADDRESS || DEFAULTS.guardian;
  const marketplaceFile = env.MARKETPLACE_FILE === undefined ? DEFAULTS.marketplaceFile : env.MARKETPLACE_FILE;
  let built;
  const marketplace =
    identity && env.MARKETPLACE !== "0"
      ? createMarketplace({
          publicClient,
          identity,
          guardian: guardianAddress,
          market: env.MARKETPLACE_ADDRESS || DEFAULTS.market,
          teamAgents: () => agentList(built, guardianAddress).agents,
          isCity: (address) => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "isCity", args: [address] }),
          file: marketplaceFile || null,
        })
      : null;
  // Presses the permissionless quarantine/restore buttons of contracts v3 when an adapter fails or recovers. Off with WATCHDOG=0.
  const watchdog = env.WATCHDOG === "0" ? null : createWatchdog({ publicClient, factory, send: (request, options) => built.sendTransaction(request, options), balance: () => publicClient.getBalance({ address: account.address }) });
  const autopilotAccount = /^0x[0-9a-fA-F]{64}$/.test(env.AUTOPILOT_PRIVATE_KEY || "") ? privateKeyToAccount(env.AUTOPILOT_PRIVATE_KEY) : null;
  const tunedImplsFile = env.TUNED_IMPLS_FILE || fileURLToPath(new URL("./catalog-tuned.json", import.meta.url));
  built = createRelayer({
    publicClient,
    walletClient,
    marketplace,
    watchdog,
    contracts: {
      chainId: 10143,
      version: env.CONTRACTS_VERSION || "v3",
      factory,
      guardian: guardianAddress,
      feed: env.FEED_ADDRESS || env.APY_FEED_ADDRESS || DEFAULTS.feed,
      reserve: env.YIELD_RESERVE_ADDRESS || DEFAULTS.reserve || null,
      mirrorAdapterImpl: env.MIRROR_ADAPTER_IMPL || DEFAULTS.mirrorImpl || null,
      cityServices,
      cityServicesFromBlock: cityServices && env.CITY_SERVICES_FROM_BLOCK ? Number(env.CITY_SERVICES_FROM_BLOCK) : null,
      marketplace: env.MARKETPLACE_ADDRESS || DEFAULTS.market,
      asset: DEFAULTS.asset,
      identityRegistry: identity?.registry.identity ?? null,
      reputationRegistry: identity?.registry.reputation ?? null,
      deployBlock: Number(env.FACTORY_DEPLOY_BLOCK || DEFAULTS.factoryDeployBlock),
      tunedImpls: loadImpls(tunedImplsFile),
      autopilot: autopilotAccount?.address ?? null,
    },
    style,
    maps,
    analyst,
    book,
    indexer,
    humas,
    economy,
    identity,
    x402,
    config: {
      factory,
      faucet: env.AUSD_FAUCET === undefined ? DEFAULTS.faucet : env.AUSD_FAUCET || null,
      maxAssets: env.MAX_DEPOSIT_ASSETS ? BigInt(env.MAX_DEPOSIT_ASSETS) : undefined,
    },
  });
  const feed = env.FEED_ADDRESS || env.APY_FEED_ADDRESS || DEFAULTS.feed;
  // Live inputs of the tuning engine (DefiLlama pools and lendBorrow, MON price), shared by the catalog, keeper and autopilot.
  built.market = createMarketData({ yields: sharedYields, pools: SEEDS.map((s) => s.pool) });
  built.catalog =
    env.CATALOG === "0"
      ? null
      : createCatalog({
          publicClient,
          mainnetClient: createPublicClient({ transport: viemHttp(env.MONAD_MAINNET_RPC || DEFAULTS.mainnetRpc) }),
          yields: sharedYields,
          feed,
          primarySourceId: env.APY_SOURCE_ID || DEFAULTS.sourceId,
          primaryVault: env.APY_SOURCE_VAULT || DEFAULTS.primaryVault,
          mirrorImpl: env.MIRROR_ADAPTER_IMPL || DEFAULTS.mirrorImpl,
          cityServices,
          implsFile: env.CATALOG_IMPLS_FILE || fileURLToPath(new URL("./catalog-impls.json", import.meta.url)),
          tunedImplsFile,
          market: built.market,
        });
  // Settles prediction markets and releases streamed service fees (main.mjs runs them with RESOLVER=1 / RELEASER=1).
  built.serviceJobs =
    cityServices && indexer
      ? createServiceJobs({ publicClient, send: (request, options) => built.sendTransaction(request, options), indexer, address: cityServices, feed, writeSource: (sourceId) => writeSource(sourceId) })
      : null;
  // City score (vault TC67.8): variety of services, how many are active, and the city's own economy.
  built.scorer = indexer ? createScorer({ publicClient, indexer, seeds: SEEDS, primarySourceId: env.APY_SOURCE_ID || DEFAULTS.sourceId }) : null;
  // Protocol tuning (vault TC67.10): the keeper writes each TunedMirrorAdapter's effective APY (main.mjs, RUN_TUNED), and the
  // autopilot carries out the mayor's rules as the city's session key (RUN_AUTOPILOT=1, needs AUTOPILOT_PRIVATE_KEY).
  built.tuned = createTunedKeeper({ publicClient, send: (request, options) => built.sendTransaction(request, options), factory, feed, tunedImpls: loadImpls(tunedImplsFile), market: built.market });
  const rulesFile = env.RULES_FILE === undefined ? DEFAULTS.rulesFile : env.RULES_FILE;
  built.autopilot = createAutopilot({
    publicClient,
    walletClient: autopilotAccount ? createWalletClient({ account: autopilotAccount, chain, transport: transport() }) : null,
    factory,
    feed,
    tuned: built.tuned,
    market: built.market,
    seeds: SEEDS,
    sourceIdOfSeed: (seed) => sourceIdOf(seed, env.APY_SOURCE_ID || DEFAULTS.sourceId),
    file: rulesFile || null,
  });
  return built;
}

/** GET /tuning/preview: the effective APY of a catalog service under a tuning, without an adapter. */
async function tuningPreview(relayer, q) {
  const service = q.get("service");
  const seed = SEEDS.find((s) => s.id === service);
  if (!seed) throw new HttpError(400, "service must be a catalog service id");
  const int = (name, def, min, max) => {
    const raw = q.get(name);
    if (raw === null || raw === "") return def;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${name} must be an integer ${min}..${max}`);
    return v;
  };
  const centerRaw = q.get("centerPriceE8");
  if (centerRaw !== null && centerRaw !== "" && !/^[0-9]{1,30}$/.test(centerRaw)) throw new HttpError(400, "centerPriceE8 must be a non-negative integer");
  const tuning = { version: 1, loopX100: int("loopX100", 100, 100, 300), takeRewards: q.get("takeRewards") !== "false" && q.get("takeRewards") !== "0", rangeBps: int("rangeBps", 0, 0, 10000), centerPriceE8: BigInt(centerRaw || 0) };
  const data = await relayer.market.forPool(seed.pool);
  const res = effectiveApy(seed.id, tuning, data);
  return { service: seed.id, tuning: tuningJson(tuning), effectiveApyBps: res.effectiveApyBps, uncappedApyBps: res.uncappedApyBps, inRange: res.inRange, breakdown: res.breakdown, notes: res.notes, knobs: knobsFor(seed.id, seed.category, data), dataFetchedAt: data.fetchedAt };
}

async function readJson(req, limit = 4096) {
  // A plain HTML form or a no-cors request cannot send this type without a CORS preflight, which closes a cheap way for
  // another website to spend a visitor's per-IP allowance.
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "send the body as application/json");
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

/** IPv4-mapped IPv6 becomes IPv4; any other IPv6 address is reduced to its /64, because one customer controls a whole /64. */
export function normalizeIp(ip) {
  if (typeof ip !== "string" || !net.isIP(ip)) return undefined;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (net.isIPv4(ip)) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...front, ...Array(8 - front.length - back.length).fill("0"), ...back] : front;
  return `${full.slice(0, 4).map((h) => (h || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * The client address. Behind a proxy, X-Forwarded-For is a list the client can pre-fill, so only the entry added by
 * the trusted proxy counts: the one `hops` places from the right (default 1). Anything that is not an IP address is
 * ignored and the socket's address is used instead.
 */
export function clientIp(req, trustProxy, hops = 1) {
  if (trustProxy) {
    const parts = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    const candidate = normalizeIp(parts[parts.length - hops]);
    if (candidate) return candidate;
  }
  return normalizeIp(req.socket?.remoteAddress);
}

export function createHttpServer(relayer, { allowedOrigins = ["http://localhost:3000"], trustProxy = false, trustedHops = 1, now = () => Date.now(), exposeIpDebug = false } = {}) {
  // Every route shares a per-IP budget, and the public GETs that read the chain are cached for a few seconds, so
  // polling cannot turn into an unbounded stream of RPC calls.
  const everything = createRateLimiter({ windowMs: 60_000, max: 240, now });
  const memo = createMemo({ now });
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowOrigin = allowedOrigins.includes("*") ? "*" : origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    // payment-signature goes in, payment-required and payment-response come out, for browsers that pay with x402.
    const corsHeaders = {
      "access-control-allow-origin": allowOrigin,
      vary: "origin",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers": "content-type,payment-signature",
      "access-control-expose-headers": "payment-required,payment-response",
    };
    const send = (status, payload, extraHeaders = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        ...corsHeaders,
        ...extraHeaders,
      });
      res.end(JSON.stringify(payload));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const ctx = { ip: clientIp(req, trustProxy, trustedHops) };
      if (req.method === "OPTIONS") return send(204, {});
      if (ctx.ip && !everything.hit(ctx.ip)) throw new HttpError(429, "too many requests from this address", { retryAfterSeconds: Math.ceil(everything.retryAfterMs(ctx.ip) / 1000) });
      if (exposeIpDebug && req.method === "GET" && path === "/whoami") return send(200, { ip: ctx.ip ?? null, xForwardedFor: req.headers["x-forwarded-for"] ?? null, socket: req.socket?.remoteAddress ?? null });
      if (req.method === "GET" && (path === "/health" || path === "/")) return send(200, await memo("health", 5_000, () => relayer.health()));
      if (req.method === "POST" && path === "/deposit") return send(200, await relayer.deposit(await readJson(req), ctx));
      if (req.method === "POST" && path === "/withdraw") return send(200, await relayer.withdraw(await readJson(req), ctx));
      if (req.method === "POST" && path === "/gas-drip") return send(200, await relayer.gasDrip(await readJson(req), ctx));
      if (req.method === "POST" && path === "/faucet") return send(200, await relayer.faucet(await readJson(req), ctx));
      if (relayer.style && req.method === "POST" && path === "/style") return send(200, await relayer.style.set(await readJson(req), ctx));
      if (relayer.style && req.method === "GET" && path.startsWith("/style/")) {
        const vault = decodeURIComponent(path.slice("/style/".length));
        return send(200, await memo(`style:${vault.toLowerCase().slice(0, 42)}`, 5_000, () => relayer.style.getWithChain(vault)));
      }
      if (relayer.maps && path.startsWith("/map/") && (req.method === "GET" || req.method === "PUT")) {
        let uri;
        try {
          uri = decodeURIComponent(path.slice("/map/".length));
        } catch {
          throw new HttpError(400, "the map key is not valid");
        }
        if (req.method === "GET") return send(200, relayer.maps.get(uri), { "cache-control": "public, max-age=86400" });
        return send(200, await relayer.maps.put(uri, await readJson(req, 700_000), ctx));
      }
      if (relayer.indexer && req.method === "GET" && path === "/leaderboard") return send(200, await memo("leaderboard", 10_000, () => relayer.indexer.leaderboard()));
      if (relayer.indexer && req.method === "GET" && path === "/metrics") return send(200, await memo("metrics", 10_000, () => relayer.indexer.metrics()));
      if (relayer.indexer && req.method === "GET" && path === "/index") return send(200, relayer.indexer.status());
      if (relayer.indexer && req.method === "GET" && path.startsWith("/history/")) {
        const city = decodeURIComponent(path.slice("/history/".length));
        if (!/^0x[0-9a-fA-F]{40}$/.test(city)) throw new HttpError(400, "city must be a vault address");
        const days = Math.min(30, Math.max(1, Math.floor(Number(new URL(req.url, "http://localhost").searchParams.get("days") ?? 7)) || 7));
        const out = await memo(`history:${city.toLowerCase()}:${days}`, 10_000, async () => relayer.indexer.history(city, days));
        if (!out) throw new HttpError(404, "the index does not know this city (yet)", { index: relayer.indexer.status() });
        return send(200, out);
      }
      if (relayer.scorer && req.method === "GET" && path.startsWith("/score/")) {
        const city = decodeURIComponent(path.slice("/score/".length));
        if (!/^0x[0-9a-fA-F]{40}$/.test(city)) throw new HttpError(400, "city must be a vault address");
        const out = await memo(`score:${city.toLowerCase()}`, 30_000, () => relayer.scorer.score(city));
        if (!out) throw new HttpError(404, "the index does not know this city (yet)", { index: relayer.indexer.status() });
        return send(200, out);
      }
      if (relayer.catalog && req.method === "GET" && path === "/catalog") return send(200, await memo("catalog", 60_000, () => relayer.catalog.get()));
      if (relayer.serviceJobs && req.method === "GET" && path === "/services") return send(200, relayer.serviceJobs.info());
      if (relayer.tuned && req.method === "GET" && path === "/tuning/preview") {
        const q = new URL(req.url, "http://localhost").searchParams;
        return send(200, await memo(`tuning-preview:${q.toString().slice(0, 300)}`, 15_000, () => tuningPreview(relayer, q)));
      }
      if (relayer.tuned && req.method === "GET" && path === "/tuned") return send(200, relayer.tuned.info());
      if (relayer.tuned && req.method === "GET" && path.startsWith("/tuning/")) {
        const adapter = decodeURIComponent(path.slice("/tuning/".length));
        if (!/^0x[0-9a-fA-F]{40}$/.test(adapter)) throw new HttpError(400, "adapter must be an address");
        const out = await memo(`tuning:${adapter.toLowerCase()}`, 10_000, () => relayer.tuned.describe(adapter));
        if (!out) throw new HttpError(404, "this adapter is not a TunedMirrorAdapter clone");
        return send(200, out);
      }
      if (relayer.autopilot && req.method === "GET" && path === "/rules/presets") return send(200, relayer.autopilot.presets());
      if (relayer.autopilot && path.startsWith("/rules/")) {
        const rest = decodeURIComponent(path.slice("/rules/".length));
        const [city, sub] = rest.split("/");
        if (req.method === "GET" && sub === "preview") return send(200, await memo(`rules-preview:${city.toLowerCase().slice(0, 42)}`, 10_000, () => relayer.autopilot.preview(city)));
        if (req.method === "GET" && !sub) return send(200, await memo(`rules:${city.toLowerCase().slice(0, 42)}`, 5_000, () => relayer.autopilot.get(city)));
        if (req.method === "PUT" && !sub) return send(200, await relayer.autopilot.set(city, await readJson(req, 12_000), ctx));
      }
      if (relayer.economy && req.method === "GET" && path === "/economy") return send(200, await relayer.economy.get());
      if (relayer.x402 && req.method === "GET" && path.startsWith("/paid/report/")) return await relayer.x402.handle(req, res, ctx, corsHeaders);
      if (relayer.humas && req.method === "GET" && path.startsWith("/report/")) {
        return send(200, await relayer.humas.report(decodeURIComponent(path.slice("/report/".length)), new URL(req.url, "http://localhost").searchParams.get("days") ?? undefined, ctx));
      }
      if (relayer.identity && req.method === "GET" && /^\/agents\/[a-z]+\/card\.json$/.test(path)) {
        const card = relayer.identity.card(path.split("/")[2]);
        if (!card) throw new HttpError(404, "no such agent");
        return send(200, card);
      }
      if (relayer.contracts && req.method === "GET" && path === "/config") return send(200, relayer.contracts);
      if (relayer.watchdog && req.method === "GET" && path === "/watchdog") return send(200, relayer.watchdog.info());
      if (relayer.marketplace && req.method === "GET" && path === "/marketplace") {
        const city = new URL(req.url, "http://localhost").searchParams.get("city");
        return send(200, await memo(`marketplace:${String(city).toLowerCase().slice(0, 42)}`, 10_000, () => relayer.marketplace.list({ city })));
      }
      if (relayer.marketplace && req.method === "POST" && path === "/marketplace/apply") return send(200, await relayer.marketplace.apply(await readJson(req), ctx));
      if (req.method === "GET" && path === "/agents") {
        const list = agentList(relayer, relayer.analyst?.config?.guardian ?? DEFAULTS.guardian);
        if (!relayer.identity) return send(200, list);
        // Reputation is read from the chain and cached, and a failed read only hides the numbers, never the list.
        const reputation = await memo("agent-reputation", 30_000, async () => {
          const rows = await Promise.all(list.agents.map(async (a) => [a.id, a.erc8004 ? await relayer.identity.reputation(a.erc8004.agentId).catch(() => null) : null]));
          return Object.fromEntries(rows);
        });
        return send(200, { ...list, agents: list.agents.map((a) => (a.erc8004 ? { ...a, erc8004: { ...a.erc8004, reputation: reputation[a.id] ?? null } } : a)) });
      }
      if (relayer.book && (req.method === "PUT" || req.method === "POST") && path === "/book") return send(200, await relayer.book.put(await readJson(req, 40_000), ctx));
      if (relayer.book && req.method === "GET" && path.startsWith("/book/")) {
        const [owner, id, ...rest] = path.slice("/book/".length).split("/").map(decodeURIComponent);
        if (rest.length) throw new HttpError(404, "not found");
        return send(200, id === undefined ? relayer.book.list(owner) : relayer.book.get(owner, id));
      }
      if (relayer.analyst && req.method === "GET" && path === "/analyst") return send(200, relayer.analyst.info());
      if (relayer.analyst && req.method === "GET" && path.startsWith("/proposals/")) return send(200, await (async () => { const city = decodeURIComponent(path.slice("/proposals/".length)); return memo(`proposals:${city.toLowerCase()}`, 5_000, () => relayer.analyst.list(city)); })());
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
  createHttpServer(relayer, { allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGIN), trustProxy: process.env.TRUST_PROXY === "1", trustedHops: Number(process.env.TRUST_PROXY_HOPS || 1), exposeIpDebug: process.env.EXPOSE_IP_DEBUG === "1" }).listen(port, "0.0.0.0", () => {
    console.log(`relayer listening on :${port} (factory ${relayer.config.factory})`);
  });
}
