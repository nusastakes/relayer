// City style (colour theme and civic works), stored by the relayer.
//
// This is cosmetic data with no effect on funds. The contracts have no place for it (`mapURI` is set once at
// `createCity`), so the relayer keeps a short code per city in a JSON file. Only the city's mayor can change it: the
// request carries an EIP-712 signature that must come from `vault.mayor()`. What is stored is the server's to keep honest,
// unlike an on-chain event, and a redeploy without a volume wipes it. A `CityVault.setStyle(bytes32)` in a v3 contract
// would be the right long-term home.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseAbi, verifyTypedData } from "viem";
import { HttpError, Mutex, createRateLimiter } from "./guards.mjs";

export const STYLE_DOMAIN = { name: "Nusastakes", version: "1", chainId: 10143 };
export const STYLE_TYPES = {
  CityStyle: [
    { name: "vault", type: "address" },
    { name: "code", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
};
export const STYLE_PRIMARY_TYPE = "CityStyle";
/** `<theme>.<mask in base 36>`, for example `sakura.7`. Empty clears the style. */
const CODE = /^[a-z0-9_-]{1,24}\.[0-9a-z]{1,12}$/;
const MAX_CODE_LENGTH = 32;
const MAX_ENTRIES = 20_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^[0-9]{1,30}$/;

const factoryAbi = parseAbi(["function isCity(address) view returns (bool)"]);
const vaultAbi = parseAbi(["function mayor() view returns (address)"]);

function vaultAddress(value) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new HttpError(400, "vault must be a 20-byte hex address");
  return value;
}

/** Validates the body of POST /style. */
export function parseStyleBody(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
  const vault = vaultAddress(body.vault);
  if (typeof body.code !== "string" || body.code.length > MAX_CODE_LENGTH || (body.code !== "" && !CODE.test(body.code))) {
    throw new HttpError(400, `code must be empty or look like "theme.mask" (lowercase letters, digits, - or _, at most ${MAX_CODE_LENGTH} characters)`);
  }
  const rawNonce = typeof body.nonce === "number" && Number.isSafeInteger(body.nonce) && body.nonce >= 0 ? String(body.nonce) : body.nonce;
  if (typeof rawNonce !== "string" || !UINT.test(rawNonce)) throw new HttpError(400, "nonce must be a non-negative integer (use a string for large numbers)");
  if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) throw new HttpError(400, "signature must be 65 bytes of hex");
  return { vault, code: body.code, nonce: BigInt(rawNonce), signature: body.signature };
}

/**
 * @param {object} deps
 * @param {{readContract: Function}} deps.publicClient
 * @param {string} deps.factory
 * @param {string} deps.file  JSON file that survives restarts (put it on a volume to survive redeploys)
 */
export function createStyleStore({ publicClient, factory, file, now = () => Date.now(), verify = verifyTypedData }) {
  /** @type {Map<string, {code: string, nonce: string}>} */
  const entries = new Map();
  const mutex = new Mutex();
  const perVault = createRateLimiter({ windowMs: 60_000, max: 10, now });
  const perIp = createRateLimiter({ windowMs: 60_000, max: 30, now });
  const global = createRateLimiter({ windowMs: 60_000, max: 120, now });

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const [vault, value] of Object.entries(saved)) {
        if (ADDRESS.test(vault) && typeof value?.code === "string" && typeof value?.nonce === "string") entries.set(vault.toLowerCase(), value);
      }
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`style file ${file} could not be read (${e?.message}); starting empty`);
    }
  }

  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    renameSync(tmp, file);
  }

  return {
    enabled: true,
    size: () => entries.size,

    /** GET /style/:vault */
    get(rawVault) {
      const vault = vaultAddress(rawVault);
      const entry = entries.get(vault.toLowerCase());
      return { code: entry?.code ?? "", nonce: entry?.nonce ?? "0" };
    },

    /** POST /style: accepted only when the signature comes from the city's mayor and the nonce is newer. */
    async set(rawBody, ctx = {}) {
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many style requests from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      const b = parseStyleBody(rawBody);
      if (!global.hit("all")) throw new HttpError(429, "relayer is busy, try again shortly", { retryAfterSeconds: 10 });
      const key = b.vault.toLowerCase();

      const isCity = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "isCity", args: [b.vault] });
      if (!isCity) throw new HttpError(400, "vault was not created by the city factory");
      const mayor = await publicClient.readContract({ address: b.vault, abi: vaultAbi, functionName: "mayor" });
      const ok = await verify({
        address: mayor,
        domain: STYLE_DOMAIN,
        types: STYLE_TYPES,
        primaryType: STYLE_PRIMARY_TYPE,
        message: { vault: b.vault, code: b.code, nonce: b.nonce },
        signature: b.signature,
      }).catch(() => false);
      if (!ok) throw new HttpError(403, "signature does not come from the city's mayor");
      // Counted only after the signature checked out, so junk aimed at a mayor's vault cannot use up the mayor's budget.
      if (!perVault.hit(key)) throw new HttpError(429, "too many style requests for this city", { retryAfterSeconds: Math.ceil(perVault.retryAfterMs(key) / 1000) });

      return mutex.run(async () => {
        const stored = entries.get(key);
        if (stored && b.nonce <= BigInt(stored.nonce)) throw new HttpError(409, `nonce must be greater than ${stored.nonce}`, { currentNonce: stored.nonce });
        if (!stored && entries.size >= MAX_ENTRIES) throw new HttpError(503, "style storage is full");
        entries.set(key, { code: b.code, nonce: b.nonce.toString() });
        try {
          persist();
        } catch (e) {
          if (stored) entries.set(key, stored);
          else entries.delete(key);
          console.error("style could not be saved:", e?.message || e);
          throw new HttpError(500, "style could not be saved");
        }
        return { vault: b.vault, code: b.code, nonce: b.nonce.toString() };
      });
    },
  };
}
