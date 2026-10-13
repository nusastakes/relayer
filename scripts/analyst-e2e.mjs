#!/usr/bin/env node
// End-to-end check of the Analyst on Monad testnet. It sends real testnet transactions.
//
//   set -a; . ../.env; set +a; CITY=0x… node scripts/analyst-e2e.mjs
//
// DEPLOYER_PRIVATE_KEY must be the mayor of CITY (it grants the role and approves the proposal); ANALYST_PRIVATE_KEY is
// the bot. ANTHROPIC_API_KEY and XKIRO_API_KEY are optional (the bot writes its reasons with the LLM when one is set). Steps: the mayor
// grants ANALIS to the bot -> the bot looks at the city and files a proposal -> the stored reason matches the on-chain
// planHash -> the mayor approves -> the money has moved.

import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANALIS_ROLE, createAnalyst, createPlanStore, verifyPlan } from "../src/analyst.mjs";

const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const GUARDIAN = "0x1ADE0E93F4C10b6d57F2E802B8B4e6167f0F0ea4";
const FACTORY = "0x194C8c5d9B93bA108104652cAD50f938e9205607";
const FEED = "0xFB64e2F4345c55e4c19271AC2E7210BFe6b9a7F0";
const SOURCE_ID = "0x71809e1e29dc09210f61029b6e5b4f037fb332bdf7caa16cf9362c78c500926d";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const city = process.env.CITY;
if (!city) throw new Error("set CITY to the vault address of a city whose mayor is the deployer");

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const mayor = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const botAccount = privateKeyToAccount(process.env.ANALYST_PRIVATE_KEY);
const mayorWallet = createWalletClient({ account: mayor, chain, transport: http(RPC) });
const botWallet = createWalletClient({ account: botAccount, chain, transport: http(RPC) });

const guardianAbi = parseAbi([
  "function grantAgent(address city, address agent, uint8 role, uint64 expiry)",
  "function approve(address city, uint256 id)",
  "function isActiveAgent(address city, address agent, uint8 role) view returns (bool)",
]);
const vaultAbi = parseAbi(["function totalAssets() view returns (uint256)", "function adapters() view returns (address[])"]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const adapterAbi = parseAbi(["function totalAssets() view returns (uint256)"]);
const fmt = (n) => (Number(n) / 1e6).toFixed(6);

async function fees() {
  const block = await pub.getBlock();
  const tip = await pub.estimateMaxPriorityFeePerGas().catch(() => 0n);
  return { maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + tip, maxPriorityFeePerGas: tip };
}
async function mayorSend(label, params) {
  const gas = ((await pub.estimateContractGas({ ...params, account: mayor })) * 12n) / 10n;
  const hash = await mayorWallet.writeContract({ ...params, gas, ...(await fees()) });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${hash}`);
}
async function state() {
  const [adapter] = await pub.readContract({ address: city, abi: vaultAbi, functionName: "adapters" });
  return {
    adapter,
    total: await pub.readContract({ address: city, abi: vaultAbi, functionName: "totalAssets" }),
    idle: await pub.readContract({ address: AUSD, abi: tokenAbi, functionName: "balanceOf", args: [city] }),
    invested: await pub.readContract({ address: adapter, abi: adapterAbi, functionName: "totalAssets" }),
  };
}

const bot = createAnalyst({
  publicClient: pub,
  walletClient: botWallet,
  store: createPlanStore(),
  llm: [
    process.env.ANTHROPIC_API_KEY && { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY },
    process.env.XKIRO_API_KEY && { provider: "xkiro", apiKey: process.env.XKIRO_API_KEY },
  ].filter(Boolean),
  config: { guardian: GUARDIAN, factory: FACTORY, feed: FEED, sourceId: SOURCE_ID, asset: AUSD },
});

console.log("city", city, "| mayor", mayor.address, "| analyst", bot.address, "| LLM", Boolean(process.env.ANTHROPIC_API_KEY));
let s = await state();
console.log(`before: total ${fmt(s.total)}, idle ${fmt(s.idle)}, invested ${fmt(s.invested)}`);

console.log("\n1. the mayor grants ANALIS to the bot for 7 days");
await mayorSend("grantAgent", { address: GUARDIAN, abi: guardianAbi, functionName: "grantAgent", args: [city, bot.address, ANALIS_ROLE, BigInt(Math.floor(Date.now() / 1000) + 7 * 86400)] });

console.log("\n2. the bot looks at the city");
const out = await bot.scanCity(city);
console.log(" ", JSON.stringify(out));
if (out.status !== "proposed") throw new Error(`expected a proposal, got ${out.status}`);

console.log("\n3. the stored reason matches the on-chain planHash");
const { proposals } = await bot.list(city);
const first = proposals[0];
console.log(`  status ${first.status}; reason: ${first.plan.reason}`);
if (!verifyPlan(first.plan, first.planHash)) throw new Error("stored plan does not match the planHash");
if (first.status !== "pending") throw new Error(`expected pending, got ${first.status}`);

console.log("\n4. the mayor approves with one call");
await mayorSend("approve", { address: GUARDIAN, abi: guardianAbi, functionName: "approve", args: [city, BigInt(first.proposalId)] });
s = await state();
console.log(`after: total ${fmt(s.total)}, idle ${fmt(s.idle)}, invested ${fmt(s.invested)}`);
if (s.invested < BigInt(first.plan.amount) - 1n) throw new Error("the money did not move");
console.log("  status now:", (await bot.list(city)).proposals[0].status);
console.log("\nANALYST E2E OK");
