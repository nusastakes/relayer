// Untrusted storage for the sealed strategy book (PRD R10, bounty B17).
//
// The browser encrypts every entry with a key derived from the mayor's passkey, so this store only ever holds
// ciphertext it cannot read. That is what makes the cross-device test work: a second device with the same passkey
// re-derives the keys, fetches the ciphertext from here and decrypts it. Nothing here is secret, but it is kept honest:
//  * only the owner's account can add an entry (an EIP-712 `BookEntry` signature, checked against `owner`);
//  * an entry id is written once and never overwritten or deleted, so a decision cannot be quietly replaced after the
//    result is known (the season-end reveal compares the decrypted entry with the hash recorded on-chain);
//  * the hash the client puts on-chain as `planHash` is `keccak256(ciphertext)`, which this store returns as `hash`.
// The relayer operator can still delete the file; the on-chain hash is what proves what was written and when.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, keccak256, verifyTypedData } from "viem";
import { HttpError, Mutex, createRateLimiter } from "./guards.mjs";
import { STYLE_DOMAIN } from "./style.mjs";

/** Same domain as the style signatures: { name: "Nusastakes", version: "1", chainId: 10143 }. */
export const BOOK_DOMAIN = STYLE_DOMAIN;
export const BOOK_TYPES = {
  BookEntry: [
    { name: "owner", type: "address" },
    { name: "id", type: "string" },
    { name: "ciphertextHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};
export const BOOK_PRIMARY_TYPE = "BookEntry";

export const MAX_CIPHERTEXT_BYTES = 16 * 1024;
export const MAX_ENTRIES_PER_OWNER = 100;
/** The whole store lives in memory and is rewritten on every write, so it is capped in bytes, not only in entries. */
export const MAX_BYTES_PER_OWNER = 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_OWNERS = 1000;
const ENTRY_ID = /^[a-zA-Z0-9._:-]{1,64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const UINT = /^[0-9]{1,30}$/;

function ownerAddress(value) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new HttpError(400, "owner must be a 20-byte hex address");
  return value;
}

/** Validates the body of PUT /book. */
export function parseBookBody(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
  const owner = ownerAddress(body.owner);
  if (typeof body.id !== "string" || !ENTRY_ID.test(body.id)) throw new HttpError(400, "id must be 1 to 64 characters of letters, digits, . _ : -");
  if (typeof body.ciphertext !== "string" || !HEX.test(body.ciphertext)) throw new HttpError(400, "ciphertext must be 0x-prefixed hex bytes");
  const bytes = (body.ciphertext.length - 2) / 2;
  if (bytes > MAX_CIPHERTEXT_BYTES) throw new HttpError(413, `ciphertext is larger than ${MAX_CIPHERTEXT_BYTES} bytes`);
  const rawNonce = typeof body.nonce === "number" && Number.isSafeInteger(body.nonce) && body.nonce >= 0 ? String(body.nonce) : body.nonce;
  if (typeof rawNonce !== "string" || !UINT.test(rawNonce)) throw new HttpError(400, "nonce must be a non-negative integer (use a string for large numbers)");
  if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) throw new HttpError(400, "signature must be 65 bytes of hex");
  return { owner, id: body.id, ciphertext: body.ciphertext.toLowerCase(), bytes, nonce: BigInt(rawNonce), signature: body.signature };
}

/**
 * @param {{file?: string, now?: () => number, verify?: Function, canWrite?: (owner: string) => boolean | Promise<boolean>}} options
 * `canWrite` gates who may store anything at all: a signature from a fresh key proves nothing, so the server passes a check
 * that the owner is a mayor or a depositor of a real city.
 */
export function createBookStore({ file, now = () => Date.now(), verify = verifyTypedData, canWrite = () => true } = {}) {
  /** @type {Map<string, {nonce: string, entries: {id: string, ciphertext: string, hash: string, bytes: number, createdAt: number}[]}>} */
  const owners = new Map();
  const mutex = new Mutex();
  const perOwner = createRateLimiter({ windowMs: 60_000, max: 20, now });
  const perIp = createRateLimiter({ windowMs: 60_000, max: 30, now });
  const global = createRateLimiter({ windowMs: 60_000, max: 120, now });
  let totalBytes = 0;

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const [owner, value] of Object.entries(saved)) if (ADDRESS.test(owner) && Array.isArray(value?.entries)) owners.set(owner.toLowerCase(), value);
      totalBytes = [...owners.values()].reduce((sum, book) => sum + book.entries.reduce((s, e) => s + e.bytes, 0), 0);
    } catch (e) {
      if (e?.code !== "ENOENT") console.error(`book file ${file} could not be read (${e?.message}); starting empty`);
    }
  }
  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(owners)));
    renameSync(tmp, file);
  }

  return {
    enabled: true,
    size: () => owners.size,

    /** PUT /book */
    async put(rawBody, ctx = {}) {
      if (ctx.ip && !perIp.hit(ctx.ip)) throw new HttpError(429, "too many book requests from this address", { retryAfterSeconds: Math.ceil(perIp.retryAfterMs(ctx.ip) / 1000) });
      const b = parseBookBody(rawBody);
      if (!global.hit("all")) throw new HttpError(429, "the book store is busy, try again shortly", { retryAfterSeconds: 10 });
      const key = b.owner.toLowerCase();

      const hash = keccak256(b.ciphertext);
      const ok = await verify({
        address: b.owner,
        domain: BOOK_DOMAIN,
        types: BOOK_TYPES,
        primaryType: BOOK_PRIMARY_TYPE,
        message: { owner: b.owner, id: b.id, ciphertextHash: hash, nonce: b.nonce },
        signature: b.signature,
      }).catch(() => false);
      if (!ok) throw new HttpError(403, "signature does not come from the owner");
      // Counted only after the signature checked out, so junk naming someone else's address cannot use up their budget.
      if (!perOwner.hit(key)) throw new HttpError(429, "too many book requests for this owner", { retryAfterSeconds: Math.ceil(perOwner.retryAfterMs(key) / 1000) });
      if (!(await canWrite(b.owner))) throw new HttpError(403, "this account has no city or deposit yet (the index can lag by a minute)");

      return mutex.run(async () => {
        const book = owners.get(key) ?? { nonce: "-1", entries: [] };
        if (b.nonce <= BigInt(book.nonce)) throw new HttpError(409, `nonce must be greater than ${book.nonce}`, { currentNonce: book.nonce });
        if (book.entries.some((e) => e.id === b.id)) throw new HttpError(409, "an entry with this id already exists; entries are never overwritten");
        if (book.entries.length >= MAX_ENTRIES_PER_OWNER) throw new HttpError(409, `this owner already has ${MAX_ENTRIES_PER_OWNER} entries`);
        if (book.entries.reduce((sum, e) => sum + e.bytes, 0) + b.bytes > MAX_BYTES_PER_OWNER) throw new HttpError(409, `this owner's entries would exceed ${MAX_BYTES_PER_OWNER} bytes`);
        if (totalBytes + b.bytes > MAX_TOTAL_BYTES) throw new HttpError(503, "book storage is full");
        if (!owners.has(key) && owners.size >= MAX_OWNERS) throw new HttpError(503, "book storage is full");
        const entry = { id: b.id, ciphertext: b.ciphertext, hash, bytes: b.bytes, createdAt: Math.floor(now() / 1000) };
        const next = { nonce: b.nonce.toString(), entries: [...book.entries, entry] };
        owners.set(key, next);
        totalBytes += b.bytes;
        try {
          persist();
        } catch (e) {
          totalBytes -= b.bytes;
          if (book.entries.length) owners.set(key, book);
          else owners.delete(key);
          console.error("book could not be saved:", e?.message || e);
          throw new HttpError(500, "book could not be saved");
        }
        return { owner: getAddress(b.owner), id: entry.id, hash, bytes: entry.bytes, createdAt: entry.createdAt, nonce: next.nonce };
      });
    },

    /** GET /book/:owner: the owner's entries without the ciphertext, plus the nonce to use next. */
    list(rawOwner) {
      const owner = ownerAddress(rawOwner);
      const book = owners.get(owner.toLowerCase());
      return {
        owner: getAddress(owner),
        nonce: book?.nonce ?? "-1",
        entries: (book?.entries ?? []).map(({ id, hash, bytes, createdAt }) => ({ id, hash, bytes, createdAt })),
      };
    },

    /** GET /book/:owner/:id: one entry with its ciphertext. */
    get(rawOwner, id) {
      const owner = ownerAddress(rawOwner);
      const entry = owners.get(owner.toLowerCase())?.entries.find((e) => e.id === id);
      if (!entry) throw new HttpError(404, "no such entry");
      return { owner: getAddress(owner), ...entry };
    },
  };
}
