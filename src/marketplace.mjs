// The AI staff exchange ("Bursa Staf AI", PRD R20): the team's own agents plus third-party agents that registered in the
// ERC-8004 Identity Registry and applied here. A mayor hires any of them with CityGuardian.grantAgent; nothing in this file
// moves money or grants anything, it only decides who is shown and how.
//
// Anyone can mint an ERC-8004 identity, so a listing is only as honest as the checks behind it. An application is accepted
// only when, all verified by this server:
//  * the agent exists on-chain and its wallet (getAgentWallet, the address a mayor would grant) is not empty;
//  * its registration file, fetched from the agent's own URI, declares the `nusastakes.city-staff` capability, a role a
//    third party can safely hold (ANALIS: may only propose, the mayor approves; HUMAS: report writer with no on-chain power;
//    never SATPAM, which is the CRE workflow's role) and lists this exact agent in this registry;
//  * the registration file is fetched by `fetchCard` below, which only talks to public HTTPS hosts (see that function).
// Text from a registration file is untrusted: it is trimmed, length-capped and stripped of control characters here, and
// the frontend must still escape it.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { encodeAbiParameters, getAddress, keccak256, parseAbi, toBytes } from "viem";
import { HttpError, Mutex, createRateLimiter } from "./guards.mjs";
import { identityAbi } from "./erc8004.mjs";

export const CAPABILITY = "nusastakes.city-staff";
/** Roles a third party may offer: 2 ANALIS (propose only) and 3 HUMAS (report only). 1 SATPAM belongs to the CRE workflow. */
export const COMMUNITY_ROLES = { 2: "ANALIS", 3: "HUMAS" };
export const MAX_LISTED = 50;
/** The capability hash each hireable role uses on the AgentMarketplace contract; CityGuardian maps it back to a role. */
export const CAPABILITY_BY_ROLE = {
  2: keccak256(toBytes("nusastakes.city-staff.analis")),
  3: keccak256(toBytes("nusastakes.city-staff.humas")),
};
const marketAbi = parseAbi([
  "struct Listing { uint256 agentId; address seller; address asset; uint128 price; uint32 period; bytes32 capability; bool active; string uri; }",
  "struct Stats { uint64 hires; uint64 lastHireAt; uint128 revenue; }",
  "function listingIdsOf(uint256 agentId) view returns (uint256[])",
  "function getListing(uint256 listingId) view returns (Listing)",
  "function statsOf(uint256 listingId) view returns (Stats)",
  "function termsHash(uint256 listingId) view returns (bytes32)",
]);
const MAX_CARD_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** The public testnet RPC drops requests under load (for example right after the relayer starts), so reads that decorate a listing try three times. */
async function retry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
    }
  }
}

// ─── Safe fetching of a registration file ──────────────────────────────────────────────────────────────────────────

function ipv4ToInt(ip) {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}
const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

/** True only for an address that is routable on the public internet. Unknown or embedded forms count as not public. */
export function isPublicIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return !V4_BLOCKS.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicIp(mapped[1]);
    if (lower === "::" || lower === "::1") return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return false; // NAT64, documentation
    if (lower.startsWith("::")) return false; // IPv4-compatible and other embedded forms
    return true;
  }
  return false;
}

/** The default transport: connect to the exact IP that was validated, but check the certificate against the hostname. */
function pinnedGet({ ip, hostname, path, signal }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: ip, servername: hostname, port: 443, path, method: "GET", headers: { host: hostname, accept: "application/json", "user-agent": "nusastakes-marketplace/1" }, signal }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_CARD_BYTES) {
          res.destroy();
          reject(new HttpError(400, `the registration file is larger than ${MAX_CARD_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, contentType: String(res.headers["content-type"] || ""), body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Loads an agent's registration file. `data:application/json` URIs are decoded locally. `https://` URIs are fetched only
 * from hostnames (never IP literals, never another port, never with credentials) whose every DNS answer is a public
 * address; the connection then goes to that checked address so a second DNS answer cannot redirect it. Redirects are
 * refused, the body is capped, and the whole call has a short timeout.
 */
export async function fetchCard(uri, { resolve = (host) => lookup(host, { all: true }), get = pinnedGet } = {}) {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > (uri.startsWith("data:") ? 48_000 : 4096)) throw new HttpError(400, "the agent has no usable URI");
  if (uri.startsWith("data:")) {
    const m = /^data:application\/json(?:;charset=utf-8)?(;base64)?,(.*)$/is.exec(uri);
    if (!m) throw new HttpError(400, "only data:application/json URIs are accepted");
    const text = m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
    if (Buffer.byteLength(text) > MAX_CARD_BYTES) throw new HttpError(400, `the registration file is larger than ${MAX_CARD_BYTES} bytes`);
    return parseJson(text);
  }
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new HttpError(400, "the agent URI is not a valid URL");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "only https:// and data:application/json URIs are accepted");
  if (url.username || url.password) throw new HttpError(400, "URIs with credentials are refused");
  if (url.port && url.port !== "443") throw new HttpError(400, "only port 443 is allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) || !hostname.includes(".") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname === "localhost") throw new HttpError(400, "the agent URI must use a public hostname");

  let answers;
  try {
    answers = await resolve(hostname);
  } catch {
    throw new HttpError(400, "the agent URI hostname does not resolve");
  }
  if (!answers.length || !answers.every((a) => isPublicIp(a.address))) throw new HttpError(400, "the agent URI resolves to a non-public address");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await get({ ip: answers[0].address, hostname, path: `${url.pathname}${url.search}`, signal: controller.signal });
    if (res.status !== 200) throw new HttpError(400, `the registration file answered HTTP ${res.status} (redirects are not followed)`);
    if (!/json|text\/plain/i.test(res.contentType)) throw new HttpError(400, "the registration file is not JSON");
    return parseJson(res.body);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, controller.signal.aborted ? "the registration file took too long to load" : "the registration file could not be loaded");
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the registration file is not valid JSON");
  }
}

// ─── Validation of a registration file ─────────────────────────────────────────────────────────────────────────────

// Control characters, zero-width and bidirectional-override characters, and line separators. Built from code points so the
// source file holds no invisible characters.
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]];
const UNSAFE = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`, "g");

/** Trimmed, control-character-free, length-capped text. */
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @returns {{name: string, description: string, roleId: number, role: string, pricing: object, services: {name: string, endpoint: string}[]}}
 * @throws HttpError(400) with the reason, so an applicant can fix their file
 */
export function validateCard(card, { agentId, agentRegistry }) {
  const fail = (why) => {
    throw new HttpError(400, `registration file rejected: ${why}`);
  };
  if (!card || typeof card !== "object" || Array.isArray(card)) fail("it is not a JSON object");
  if (card.type !== REGISTRATION_TYPE) fail(`"type" must be ${REGISTRATION_TYPE}`);
  const name = cleanText(card.name, 80);
  if (!name) fail('"name" is missing');
  const registrations = Array.isArray(card.registrations) ? card.registrations : [];
  if (!registrations.some((r) => r && Number(r.agentId) === Number(agentId) && String(r.agentRegistry).toLowerCase() === agentRegistry.toLowerCase())) fail(`"registrations" must list agent ${agentId} in ${agentRegistry}`);
  const ext = card.nusastakes;
  if (!ext || typeof ext !== "object") fail('the "nusastakes" section is missing');
  if (ext.capability !== CAPABILITY) fail(`"nusastakes.capability" must be "${CAPABILITY}"`);
  const roleId = Number(ext.roleId);
  if (!COMMUNITY_ROLES[roleId]) fail('"nusastakes.roleId" must be 2 (ANALIS) or 3 (HUMAS); SATPAM is reserved for the CRE workflow');
  const model = ["free", "x402", "fee-share"].includes(ext.pricing?.model) ? ext.pricing.model : "free";
  const pricing = { model, ...(model === "x402" && cleanText(ext.pricing?.amount, 20) ? { amount: cleanText(ext.pricing.amount, 20) } : {}) };
  const services = (Array.isArray(card.services) ? card.services : [])
    .slice(0, 8)
    .map((s) => ({ name: cleanText(s?.name, 30), endpoint: cleanText(s?.endpoint, 200) }))
    .filter((s) => s.name && s.endpoint);
  return { name, description: cleanText(card.description, 600), roleId, role: COMMUNITY_ROLES[roleId], pricing, services };
}

// ─── The exchange ──────────────────────────────────────────────────────────────────────────────────────────────────

const guardianReadAbi = [{ type: "function", name: "isActiveAgent", stateMutability: "view", inputs: [{ name: "city", type: "address" }, { name: "agent", type: "address" }, { name: "role", type: "uint8" }], outputs: [{ type: "bool" }] }];

/**
 * @param {{publicClient: any, identity: any, guardian: string, teamAgents: () => any[], isCity: (address: string) => Promise<boolean>, file?: string | null, now?: () => number, cardFetcher?: Function}} options
 * `teamAgents` returns the team's own entries (from agentList); community entries come from applications saved in `file`.
 */
export function createMarketplace({ publicClient, identity, guardian, teamAgents, isCity, market = null, file = null, now = () => Date.now(), cardFetcher = fetchCard, ipLimit = 5, globalLimit = 30 }) {
  /** @type {Map<string, any>} */
  const listed = new Map();
  const mutex = new Mutex();
  const perIp = createRateLimiter({ windowMs: 3_600_000, max: ipLimit, now });
  const global = createRateLimiter({ windowMs: 3_600_000, max: globalLimit, now });
  const agentRegistry = identity.registry.agentRegistry;

  if (file) {
    try {
      for (const entry of JSON.parse(readFileSync(file, "utf8")).agents ?? []) listed.set(String(entry.agentId), entry);
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`marketplace file ${file} could not be read (${e?.message}); starting empty`);
    }
  }
  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ agents: [...listed.values()] }));
    renameSync(tmp, file);
  }

  const read = (functionName, args) => publicClient.readContract({ address: identity.registry.identity, abi: identityAbi, functionName, args });

  /**
   * What the AgentMarketplace contract currently offers for an agent: each listing with its price, period, on-chain hire
   * statistics, and whether it can be hired right now (open, made by the agent's current owner, and for the capability
   * that matches the role). Empty when no marketplace contract is configured.
   */
  async function offersOf(agentId, roleId, ownerNow) {
    if (!market) return [];
    const ids = await publicClient.readContract({ address: market, abi: marketAbi, functionName: "listingIdsOf", args: [BigInt(agentId)] });
    return Promise.all(
      ids.map(async (id) => {
        const [l, st, terms] = await Promise.all([
          publicClient.readContract({ address: market, abi: marketAbi, functionName: "getListing", args: [id] }),
          publicClient.readContract({ address: market, abi: marketAbi, functionName: "statsOf", args: [id] }),
          publicClient.readContract({ address: market, abi: marketAbi, functionName: "termsHash", args: [id] }),
        ]);
        const matches = CAPABILITY_BY_ROLE[roleId] === l.capability;
        const current = ownerNow ? getAddress(l.seller) === getAddress(ownerNow) : true;
        return {
          listingId: id.toString(),
          asset: getAddress(l.asset),
          price: l.price.toString(),
          period: Number(l.period),
          capability: l.capability,
          termsHash: terms,
          capabilityMatchesRole: matches,
          active: l.active,
          hireable: l.active && matches && current,
          hires: Number(st.hires),
          lastHireAt: Number(st.lastHireAt),
          revenue: st.revenue.toString(),
        };
      }),
    );
  }

  /** The call a mayor makes to hire through the contract (the guardian is the hook that grants the role). */
  function hireInfo(offer, cityAddress) {
    return {
      via: "marketplace",
      contract: market,
      function: "hire(uint256 listingId, uint64 periods, bytes32 expectedTerms, address hook, bytes data)",
      permitFunction: "hireWithPermit(uint256 listingId, uint64 periods, bytes32 expectedTerms, address hook, bytes data, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
      listingId: offer.listingId,
      periods: 1,
      // A fingerprint of the price, period, capability, token, seller and wallet the buyer is looking at; the hire fails if
      // the seller changes any of them before it lands. Re-read it (GET /marketplace or termsHash) just before sending.
      expectedTerms: offer.termsHash,
      hook: guardian,
      data: cityAddress ? encodeAbiParameters([{ type: "address" }], [cityAddress]) : "abi.encode(address city)",
      asset: offer.asset,
      price: offer.price,
      period: offer.period,
      note: "the caller must be the city's mayor and must have approved the asset for the marketplace (or sign a permit); the agent's wallet is paid directly",
    };
  }

  return {
    enabled: true,
    size: () => listed.size,

    /** POST /marketplace/apply { agentId } */
    async apply(body, ctx = {}) {
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many applications from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      const raw = body?.agentId;
      const text = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
      if (typeof text !== "string" || !/^[0-9]{1,12}$/.test(text)) throw new HttpError(400, "agentId must be a non-negative integer");
      if (!global.hit("all")) throw new HttpError(429, "the exchange is busy, try again later", { retryAfterSeconds: 600 });
      if (teamAgents().some((a) => a.erc8004?.agentId === text)) throw new HttpError(409, "this agent is already listed as part of the team");

      const agentId = BigInt(text);
      let owner;
      let wallet;
      let uri;
      try {
        [owner, wallet, uri] = await Promise.all([read("ownerOf", [agentId]), read("getAgentWallet", [agentId]), read("tokenURI", [agentId])]);
      } catch {
        throw new HttpError(404, `agent ${text} does not exist in the Identity Registry`);
      }
      if (/^0x0{40}$/i.test(wallet)) throw new HttpError(400, "the agent has no wallet set");
      const card = validateCard(await cardFetcher(uri), { agentId: text, agentRegistry });
      if (market) {
        const offers = await offersOf(text, card.roleId, owner);
        if (!offers.some((o) => o.hireable)) throw new HttpError(400, "list this agent on the AgentMarketplace contract first (an open listing by its owner with the capability for its role), then apply again; see AGENTS.md");
      }
      const entry = { agentId: text, owner: getAddress(owner), wallet: getAddress(wallet), agentURI: cleanText(uri, 300), ...card, cardHash: createHash("sha256").update(JSON.stringify(card)).digest("hex"), appliedAt: Math.floor(now() / 1000) };

      return mutex.run(async () => {
        if (!listed.has(text) && listed.size >= MAX_LISTED) throw new HttpError(503, `the exchange already lists ${MAX_LISTED} community agents`);
        const before = listed.get(text);
        listed.set(text, entry);
        try {
          persist();
        } catch (e) {
          if (before) listed.set(text, before);
          else listed.delete(text);
          console.error("marketplace could not be saved:", e?.message || e);
          throw new HttpError(500, "the listing could not be saved");
        }
        return { listed: true, updated: Boolean(before), agent: publicEntry(entry, agentRegistry) };
      });
    },

    /**
     * GET /marketplace[?city=0x…]: team and community agents, best reputation first. With a city, each agent also says
     * whether that city's mayor currently has it hired.
     */
    async list({ city = null } = {}) {
      let cityAddress = null;
      if (city) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(city)) throw new HttpError(400, "city must be a 20-byte hex address");
        if (!(await isCity(city))) throw new HttpError(404, "that address is not a city created by the factory");
        cityAddress = getAddress(city);
      }
      const team = teamAgents().map((a) => ({
        source: "team",
        id: a.id,
        name: a.name,
        description: a.description,
        roleId: a.role,
        role: a.roleName,
        wallet: a.address,
        status: a.status,
        pricing: { model: "free" },
        reportPricing: a.id === "humas" && a.x402 ? { model: "x402", amount: a.x402.price, route: a.x402.route, also: "the free report stays at GET /report/:city" } : null,
        erc8004: a.erc8004,
        services: [],
        hireable: true,
      }));
      const community = await Promise.all(
        [...listed.values()].map(async (e) => {
          // The owner may have moved the agent or changed its wallet since it applied; say so instead of showing stale data.
          const [owner, wallet] = await Promise.all([read("ownerOf", [BigInt(e.agentId)]).catch(() => null), read("getAgentWallet", [BigInt(e.agentId)]).catch(() => null)]);
          const changed = !owner || !wallet || getAddress(wallet) !== e.wallet || getAddress(owner) !== e.owner;
          return { ...publicEntry(e, agentRegistry), source: "community", status: changed ? "changed-since-application" : "listed", hireable: !changed };
        }),
      );
      const all = [...team, ...community];
      await Promise.all(
        all.map(async (a) => {
          const idText = a.erc8004?.agentId ?? null;
          a.offers = idText && a.roleId && a.id !== "satpam" ? await retry(() => offersOf(idText, a.roleId, a.erc8004?.owner ?? null)).catch(() => []) : [];
          const open = a.offers.find((o) => o.hireable);
          if (open && a.hireable !== false) {
            a.hireVia = hireInfo(open, cityAddress);
            a.pricing = { model: BigInt(open.price) === 0n ? "free" : "onchain", asset: open.asset, price: open.price, period: open.period, listingId: open.listingId };
          }
          a.reputation = idText ? await retry(() => identity.reputation(idText)).catch(() => null) : null;
          if (cityAddress && a.wallet && a.hireable !== false && a.roleId) {
            a.hiredInCity = await retry(() => publicClient.readContract({ address: guardian, abi: guardianReadAbi, functionName: "isActiveAgent", args: [cityAddress, a.wallet, a.roleId] })).catch(() => null);
          }
          a.hire = a.wallet && a.roleId ? { contract: guardian, function: "grantAgent(address city, address agent, uint8 role, uint64 expiry)", agent: a.wallet, role: a.roleId, ...(a.id === "satpam" ? { note: "the address is a marker: granting it makes the city accept reports from the Chainlink CRE workflow" } : {}) } : null;
          if (idText) a.rate = { registry: identity.registry.reputation, function: "giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)", agentId: idText, note: "rate from a wallet that does not own the agent; the registry refuses self-feedback" };
        }),
      );
      const score = (a) => (a.reputation?.average ?? -1) * 1e6 + (a.reputation?.count ?? 0);
      all.sort((x, y) => score(y) - score(x));
      return { capability: CAPABILITY, guardian, marketplace: market, registry: identity.registry, city: cityAddress, count: all.length, agents: all, apply: "POST /marketplace/apply { agentId } after registering in the Identity Registry; guide in relayer/AGENTS.md" };
    },
  };
}

function publicEntry(e, agentRegistry) {
  return {
    id: `erc8004:${e.agentId}`,
    name: e.name,
    description: e.description,
    roleId: e.roleId,
    role: e.role,
    wallet: e.wallet,
    pricing: e.pricing,
    services: e.services,
    erc8004: { agentId: e.agentId, owner: e.owner, agentURI: e.agentURI, registry: agentRegistry },
    appliedAt: e.appliedAt,
    cardHash: e.cardHash,
  };
}
