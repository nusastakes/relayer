#!/usr/bin/env node
// Buys one Humas report over x402 on Monad testnet and shows where the money went.
//
//   RELAYER_URL=https://relayer-production-39e1.up.railway.app node scripts/x402-pay.mjs [city]
//
// The buyer is a throwaway wallet (or X402_BUYER_KEY): it gets test AUSD from the relayer's faucet and holds no MON, so
// the only thing that can pay for gas is the facilitator. Prints the AUSD balances of the buyer and of Humas before and
// after, and the settlement transaction. Testnet only.

import { createPublicClient, defineChain, erc20Abi, formatUnits, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const BASE = (process.env.RELAYER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const FAUCET_BASE = (process.env.FAUCET_URL || BASE).replace(/\/+$/, ""); // set FAUCET_URL when testing a local relayer that has no faucet
const CITY = process.argv[2] || "0x887AC9965980f680dEbd08A30e2FB33aE99F2397"; // the demo city, where Humas is hired
const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const ausd = async (address) => formatUnits(await publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [address] }), 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buyer = privateKeyToAccount(process.env.X402_BUYER_KEY || generatePrivateKey());
const agents = await (await fetch(`${BASE}/agents`)).json();
const humas = agents.agents.find((a) => a.id === "humas");
if (!humas?.x402) throw new Error("this relayer has no x402 route enabled");
console.log(`buyer ${buyer.address}, MON ${await publicClient.getBalance({ address: buyer.address })}`);
console.log(`route ${humas.x402.route}, price ${humas.x402.price}, pays ${humas.x402.payTo}`);

if (Number(await ausd(buyer.address)) < 1) {
  // The public faucet is shared and rate limited; wait out its cooldown instead of failing.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${FAUCET_BASE}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: buyer.address }) });
    const body = await res.json();
    if (res.ok) break;
    if (!body.faucetCooldown || attempt >= 6) throw new Error(`faucet refused: ${JSON.stringify(body)}`);
    console.log(`faucet cooling down, waiting ${body.retryAfterSeconds ?? 20}s (attempt ${attempt})`);
    await sleep(((body.retryAfterSeconds ?? 20) + 2) * 1000);
  }
  for (let i = 0; i < 20 && Number(await ausd(buyer.address)) < 1; i++) await sleep(1500);
}
const before = { buyer: await ausd(buyer.address), humas: await ausd(humas.x402.payTo) };
console.log(`before: buyer ${before.buyer} AUSD, Humas ${before.humas} AUSD`);

// Without paying, the route must answer 402 and describe what it wants.
const unpaid = await fetch(`${BASE}/paid/report/${CITY}?days=7`);
console.log(`unpaid request -> ${unpaid.status}${unpaid.headers.get("payment-required") ? " (PAYMENT-REQUIRED header present)" : ""}`);

// AUSD is not one of the SDK's default assets, so the client refuses it unless told otherwise. Allow exactly this token on
// this network, capped at 0.10 AUSD per payment (the report costs 0.01).
const payingFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:10143", client: new ExactEvmScheme(buyer) }],
  spendControls: { allowedAssets: [{ network: "eip155:10143", asset: AUSD, maxAmountPerPayment: "100000" }] },
});
const res = await payingFetch(`${BASE}/paid/report/${CITY}?days=7`);
const body = await res.json();
const receiptHeader = res.headers.get("payment-response");
const receipt = receiptHeader ? decodePaymentResponseHeader(receiptHeader) : null;
console.log(`paid request -> ${res.status}; report status ${body.status}; charged ${body.charged}`);
if (receipt) console.log(`settlement: ${JSON.stringify({ success: receipt.success, transaction: receipt.transaction, network: receipt.network, payer: receipt.payer })}`);
if (body.text) console.log(`report starts: ${String(body.text).slice(0, 160).replace(/\s+/g, " ")}…`);

await sleep(2000);
const after = { buyer: await ausd(buyer.address), humas: await ausd(humas.x402.payTo) };
console.log(`after:  buyer ${after.buyer} AUSD (${(Number(after.buyer) - Number(before.buyer)).toFixed(6)}), Humas ${after.humas} AUSD (+${(Number(after.humas) - Number(before.humas)).toFixed(6)})`);
console.log(`buyer MON at the end: ${await publicClient.getBalance({ address: buyer.address })}`);
if (!res.ok || !body.charged) process.exitCode = 1;
