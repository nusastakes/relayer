#!/usr/bin/env node
// Checks /style on a running relayer with a real mayor signature.
//   DEPLOYER_PRIVATE_KEY=0x… VAULT=0x… RELAYER_URL=https://… node scripts/style-check.mjs [code]
// The key must belong to vault.mayor(). The nonce is the current time in seconds, so it always goes up.
import { privateKeyToAccount } from "viem/accounts";
import { STYLE_DOMAIN, STYLE_PRIMARY_TYPE, STYLE_TYPES } from "../src/style.mjs";

const base = (process.env.RELAYER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const vault = process.env.VAULT;
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const code = process.argv[2] ?? "sakura.7";
const nonce = Math.floor(Date.now() / 1000);
const signature = await account.signTypedData({ domain: STYLE_DOMAIN, types: STYLE_TYPES, primaryType: STYLE_PRIMARY_TYPE, message: { vault, code, nonce: BigInt(nonce) } });
const post = await fetch(`${base}/style`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3100" }, body: JSON.stringify({ vault, code, nonce: String(nonce), signature }) });
console.log("POST /style", post.status, await post.text(), "| CORS:", post.headers.get("access-control-allow-origin"));
const get = await fetch(`${base}/style/${vault}`);
console.log("GET  /style", get.status, await get.text());
