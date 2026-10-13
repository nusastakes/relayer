// City map cache (frontend request U-15 (c), backlog B2.13).
//
// The 3D city is built from OpenStreetMap buildings and roads for the area a mayor picked. Fetching that from Overpass on every
// visit is slow and rate limited, so the first visitor uploads the result here and everyone after reads it from this cache.
// Anyone could poison an unsigned cache, so a map is accepted only when:
//  * the key (`:uri`) is the `mapURI` of a city created by the factory, which the request names with `vault`;
//  * an EIP-712 `CityMap(vault, uri, mapHash)` signature comes from that city's `mayor()`, and `mapHash` is the keccak256 of
//    the map as JSON (`JSON.stringify(map)` of the object after parsing the request, which is what a JavaScript client sent);
//  * the map has the shape the frontend reads (`id` equal to the key, `buildings` and `roads` arrays) and fits the size cap;
//  * nothing is stored for that key yet: the first signed map wins and is never replaced.
// Known limit: two cities that picked the same `mapURI` (the same spot) share one entry, so a mayor who writes first decides
// what everybody sees for that spot. A map is display data only, never a source of truth for money, and the frontend must treat
// its contents as untrusted.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, parseAbi, toBytes, verifyTypedData } from "viem";
import { HttpError, Mutex, createRateLimiter } from "./guards.mjs";
import { STYLE_DOMAIN } from "./style.mjs";

export const MAP_DOMAIN = STYLE_DOMAIN;
export const MAP_TYPES = {
  CityMap: [
    { name: "vault", type: "address" },
    { name: "uri", type: "string" },
    { name: "mapHash", type: "bytes32" },
  ],
};
export const MAP_PRIMARY_TYPE = "CityMap";

export const MAX_MAP_BYTES = 600 * 1024;
export const MAX_MAPS = 500;
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
/** What a map key looks like today (`osm:<lat>,<lon>`) and what the planned richer form may add (size, release). */
const URI = /^[A-Za-z0-9][A-Za-z0-9:.,_+@-]{0,79}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

const factoryAbi = parseAbi(["function isCity(address) view returns (bool)"]);
const vaultAbi = parseAbi(["function mayor() view returns (address)", "function mapURI() view returns (string)"]);

export function checkUri(value) {
  if (typeof value !== "string" || !URI.test(value)) throw new HttpError(400, "the map key must be 1 to 80 characters of letters, digits and : . , _ + @ -");
  return value;
}

/** The map as the server hashes and stores it. */
export const canonicalMap = (map) => JSON.stringify(map);

/** Validates the body of PUT /map/:uri. */
export function parseMapBody(uri, body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
  if (typeof body.vault !== "string" || !ADDRESS.test(body.vault)) throw new HttpError(400, "vault must be a 20-byte hex address");
  if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) throw new HttpError(400, "signature must be 65 bytes of hex");
  const map = body.map;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new HttpError(400, "map must be a JSON object");
  if (map.id !== uri) throw new HttpError(400, "map.id must equal the key in the URL");
  if (!Array.isArray(map.buildings) || !Array.isArray(map.roads)) throw new HttpError(400, "map.buildings and map.roads must be arrays");
  const text = canonicalMap(map);
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_MAP_BYTES) throw new HttpError(413, `the map is larger than ${MAX_MAP_BYTES} bytes`);
  return { vault: body.vault, signature: body.signature, map, text, bytes, mapHash: keccak256(toBytes(text)) };
}

/**
 * @param {{publicClient: any, factory: string, dir?: string | null, now?: () => number, verify?: Function, maxMaps?: number, maxTotalBytes?: number}} options
 * `dir` holds one file per map plus an index; without it the cache lives in memory only (tests).
 */
export function createMapStore({ publicClient, factory, dir = null, now = () => Date.now(), verify = verifyTypedData, maxMaps = MAX_MAPS, maxTotalBytes = MAX_TOTAL_BYTES }) {
  /** @type {Map<string, {file: string, bytes: number, vault: string, mapHash: string, signer: string, createdAt: number}>} */
  const index = new Map();
  /** In-memory copy when there is no directory. */
  const memory = new Map();
  const mutex = new Mutex();
  const perIp = createRateLimiter({ windowMs: 60_000, max: 10, now });
  const overall = createRateLimiter({ windowMs: 60_000, max: 60, now });
  let totalBytes = 0;
  const indexFile = dir ? join(dir, "index.json") : null;

  if (indexFile) {
    try {
      const saved = JSON.parse(readFileSync(indexFile, "utf8"));
      for (const [uri, meta] of Object.entries(saved)) {
        if (URI.test(uri) && typeof meta?.file === "string" && /^[0-9a-f]{40}\.json$/.test(meta.file) && existsSync(join(dir, meta.file))) {
          index.set(uri, meta);
          totalBytes += Number(meta.bytes) || 0;
        }
      }
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`map index ${indexFile} could not be read (${e?.message}); starting empty`);
    }
  }

  const has = (uri) => index.has(uri) || memory.has(uri);
  const fileNameFor = (uri) => `${createHash("sha256").update(uri).digest("hex").slice(0, 40)}.json`;

  function persist() {
    if (!indexFile) return;
    const tmp = `${indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(index)));
    renameSync(tmp, indexFile);
  }

  return {
    enabled: true,
    size: () => index.size + memory.size,

    /** GET /map/:uri: the map itself, or 404. */
    get(rawUri) {
      const uri = checkUri(rawUri);
      if (!dir) {
        const hit = memory.get(uri);
        if (!hit) throw new HttpError(404, "no map cached for this key");
        return hit.map;
      }
      const meta = index.get(uri);
      if (!meta) throw new HttpError(404, "no map cached for this key");
      try {
        return JSON.parse(readFileSync(join(dir, meta.file), "utf8")).map;
      } catch {
        throw new HttpError(404, "no map cached for this key");
      }
    },

    /** PUT /map/:uri */
    async put(rawUri, rawBody, ctx = {}) {
      const uri = checkUri(rawUri);
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many map uploads from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      const b = parseMapBody(uri, rawBody);
      if (!overall.hit("all")) throw new HttpError(429, "the map cache is busy, try again shortly", { retryAfterSeconds: 10 });
      if (has(uri)) throw new HttpError(409, "a map is already cached for this key; the first signed map is kept");

      const isCity = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "isCity", args: [b.vault] });
      if (!isCity) throw new HttpError(400, "vault was not created by the city factory");
      const [mayor, mapURI] = await Promise.all([
        publicClient.readContract({ address: b.vault, abi: vaultAbi, functionName: "mayor" }),
        publicClient.readContract({ address: b.vault, abi: vaultAbi, functionName: "mapURI" }),
      ]);
      if (mapURI !== uri) throw new HttpError(400, "the city's mapURI is not this key");
      const ok = await verify({
        address: mayor,
        domain: MAP_DOMAIN,
        types: MAP_TYPES,
        primaryType: MAP_PRIMARY_TYPE,
        message: { vault: getAddress(b.vault), uri, mapHash: b.mapHash },
        signature: b.signature,
      }).catch(() => false);
      if (!ok) throw new HttpError(403, "signature does not come from the city's mayor");

      return mutex.run(async () => {
        if (has(uri)) throw new HttpError(409, "a map is already cached for this key; the first signed map is kept");
        if (index.size + memory.size >= maxMaps || totalBytes + b.bytes > maxTotalBytes) throw new HttpError(503, "the map cache is full");
        const record = { uri, vault: getAddress(b.vault), mapHash: b.mapHash, signer: getAddress(mayor), createdAt: Math.floor(now() / 1000), map: b.map };
        if (!dir) {
          memory.set(uri, record);
        } else {
          const file = fileNameFor(uri);
          try {
            mkdirSync(dir, { recursive: true });
            const tmp = join(dir, `${file}.tmp`);
            writeFileSync(tmp, JSON.stringify(record));
            renameSync(tmp, join(dir, file));
            index.set(uri, { file, bytes: b.bytes, vault: record.vault, mapHash: b.mapHash, signer: record.signer, createdAt: record.createdAt });
            persist();
          } catch (e) {
            index.delete(uri);
            console.error("map could not be saved:", e?.message || e);
            throw new HttpError(500, "the map could not be saved");
          }
        }
        totalBytes += b.bytes;
        return { uri, vault: record.vault, mapHash: b.mapHash, bytes: b.bytes, signer: record.signer, createdAt: record.createdAt };
      });
    },

    has,
  };
}
