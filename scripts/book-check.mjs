#!/usr/bin/env node
// Checks the sealed-book store on a running relayer with a real account signature.
//   OWNER_PRIVATE_KEY=0x… RELAYER_URL=https://… node scripts/book-check.mjs
// Writes one ciphertext entry, reads it back, and checks that the hash matches keccak256(ciphertext).
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BOOK_DOMAIN, BOOK_PRIMARY_TYPE, BOOK_TYPES } from "../src/book.mjs";

const base = (process.env.RELAYER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY || generatePrivateKey());
const id = `check-${Date.now()}`;
const ciphertext = toHex(crypto.getRandomValues(new Uint8Array(96))); // stands in for AES-GCM output
const list0 = await (await fetch(`${base}/book/${account.address}`)).json();
const nonce = BigInt(list0.nonce) + 1n;
const signature = await account.signTypedData({ domain: BOOK_DOMAIN, types: BOOK_TYPES, primaryType: BOOK_PRIMARY_TYPE, message: { owner: account.address, id, ciphertextHash: keccak256(ciphertext), nonce } });
const put = await fetch(`${base}/book`, { method: "PUT", headers: { "content-type": "application/json", origin: "http://localhost:3100" }, body: JSON.stringify({ owner: account.address, id, ciphertext, nonce: nonce.toString(), signature }) });
const out = await put.json();
console.log("PUT /book", put.status, JSON.stringify(out), "| CORS:", put.headers.get("access-control-allow-origin"));
const one = await (await fetch(`${base}/book/${account.address}/${id}`)).json();
console.log("GET entry: ciphertext round trip", one.ciphertext === ciphertext, "| hash matches", keccak256(one.ciphertext) === out.hash);
const rewrite = toHex(crypto.getRandomValues(new Uint8Array(96)));
const nonce2 = nonce + 1n;
const signature2 = await account.signTypedData({ domain: BOOK_DOMAIN, types: BOOK_TYPES, primaryType: BOOK_PRIMARY_TYPE, message: { owner: account.address, id, ciphertextHash: keccak256(rewrite), nonce: nonce2 } });
const again = await fetch(`${base}/book`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: account.address, id, ciphertext: rewrite, nonce: nonce2.toString(), signature: signature2 }) });
console.log("rewriting the same id with a valid signature:", again.status, (await again.json()).error);
const agents = await (await fetch(`${base}/agents`)).json();
console.log("GET /agents:", agents.agents.map((a) => `${a.id}:${a.status}`).join(", "));
