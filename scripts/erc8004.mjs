#!/usr/bin/env node
// Registers the three staff agents in the ERC-8004 Identity Registry on Monad testnet and rates them in the Reputation
// Registry (backlog BX.6 and BX.4). Testnet only: it refuses any other chain.
//
//   set -a; . ../.env; . ../cre/.env; set +a
//   node scripts/erc8004.mjs register            # one transaction per agent, from the agent's own wallet; safe to rerun
//   node scripts/erc8004.mjs seed                # one demo rating per agent, from the mayor wallet (never the agent's owner)
//   node scripts/erc8004.mjs feedback analis 90 proposal-quality demo-seed https://… [endpoint]
//   node scripts/erc8004.mjs status              # reads everything back from the chain
//
// Keys come from the environment and are never printed: ANALYST_PRIVATE_KEY (Analis), HUMAS_PRIVATE_KEY (Humas),
// CRE_ETH_PRIVATE_KEY (Satpam: the CRE workflow owner wallet) and DEPLOYER_PRIVATE_KEY (the mayor that rates).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC8004_TESTNET, STAFF, createAgentIdentity, identityAbi, reputationAbi } from "../src/erc8004.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(here, "../deployments/erc8004-testnet.json");
const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const BASE = (process.env.PUBLIC_URL || "https://relayer-production-39e1.up.railway.app").replace(/\/+$/, "");
const EXPLORER = "https://testnet.monadvision.com";
const KEY_VARS = { satpam: "CRE_ETH_PRIVATE_KEY", analis: "ANALYST_PRIVATE_KEY", humas: "HUMAS_PRIVATE_KEY" };

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });

function load() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    return { chainId: 10143, identityRegistry: ERC8004_TESTNET.identityRegistry, reputationRegistry: ERC8004_TESTNET.reputationRegistry, agents: {} };
  }
}
function save(data) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
}
function walletFor(envVar) {
  const key = process.env[envVar];
  if (!key) throw new Error(`${envVar} is not set (source ../.env and ../cre/.env first)`);
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC) }) };
}

/** Sends a contract call with fees that match what Monad charges (the gas limit, not the gas used). */
async function send(wallet, request) {
  const gas = ((await publicClient.estimateContractGas({ ...request, account: wallet.account })) * 12n) / 10n;
  const block = await publicClient.getBlock();
  const tip = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n);
  const maxFeePerGas = (block.baseFeePerGas * 3n) / 2n + tip;
  const hash = await wallet.client.writeContract({ ...request, gas, maxFeePerGas, maxPriorityFeePerGas: tip });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return { hash, receipt };
}

async function assertTestnet() {
  const id = await publicClient.getChainId();
  if (id !== 10143) throw new Error(`refusing to run on chain ${id}; this script is testnet only`);
  const version = await publicClient.readContract({ address: ERC8004_TESTNET.identityRegistry, abi: identityAbi, functionName: "getVersion" });
  if (version !== "2.0.0") throw new Error(`unexpected Identity Registry version ${version}`);
}

async function register() {
  const data = load();
  for (const id of Object.keys(STAFF)) {
    if (data.agents[id]?.agentId !== undefined) {
      console.log(`${id}: already registered as agent ${data.agents[id].agentId}`);
      continue;
    }
    const wallet = walletFor(KEY_VARS[id]);
    const agentURI = `${BASE}/agents/${id}/card.json`;
    const { hash, receipt } = await send(wallet, { address: ERC8004_TESTNET.identityRegistry, abi: identityAbi, functionName: "register", args: [agentURI] });
    const log = receipt.logs.map((l) => { try { return decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "Registered");
    if (!log) throw new Error(`${id}: no Registered event in ${hash}`);
    data.agents[id] = { agentId: log.args.agentId.toString(), owner: getAddress(wallet.account.address), agentURI, registerTx: hash };
    save(data);
    console.log(`${id}: agent ${log.args.agentId} owned by ${wallet.account.address}, tx ${hash}`);
  }
}

async function feedback(id, value, tag1, tag2, feedbackURI = "", endpoint = "") {
  const data = load();
  const entry = data.agents[id];
  if (!entry) throw new Error(`${id} is not registered yet`);
  const wallet = walletFor("DEPLOYER_PRIVATE_KEY");
  const { hash } = await send(wallet, {
    address: ERC8004_TESTNET.reputationRegistry,
    abi: reputationAbi,
    functionName: "giveFeedback",
    args: [BigInt(entry.agentId), BigInt(value), 0, tag1, tag2, endpoint, feedbackURI, zeroHash],
  });
  const record = { from: getAddress(wallet.account.address), value: Number(value), tag1, tag2, feedbackURI, tx: hash };
  data.feedback = [...(data.feedback ?? []), { agent: id, ...record }];
  save(data);
  console.log(`${id}: rated ${value} (${tag1}/${tag2}) by ${wallet.account.address}, tx ${hash}`);
}

// Honest seeding: these ratings come from the platform's own mayor wallet, tagged `demo-seed`, and each points at the
// evidence it is based on. They show the mechanism working; they are not independent users.
async function seed() {
  await feedback("satpam", 100, "evacuation", "demo-seed", `${EXPLORER}/tx/0x10749bb7f363aaeae6461b6d3f31175921148f79da323baa478c3251a6332cca`, "cre workflow simulate --broadcast");
  await feedback("analis", 90, "proposal-quality", "demo-seed", `${BASE}/proposals/0x35E98BA6f55c65dF272a2ee740025eeB5df85cE6`, `${BASE}/proposals/{city}`);
  await feedback("humas", 85, "report-quality", "demo-seed", `${BASE}/report/0x35E98BA6f55c65dF272a2ee740025eeB5df85cE6?days=7`, `${BASE}/report/{city}`);
}

async function status() {
  const data = load();
  const identity = createAgentIdentity({ publicClient, baseUrl: BASE, deployments: data });
  console.log(`identity registry ${ERC8004_TESTNET.identityRegistry} v${await publicClient.readContract({ address: ERC8004_TESTNET.identityRegistry, abi: identityAbi, functionName: "getVersion" })}`);
  console.log(`reputation registry ${ERC8004_TESTNET.reputationRegistry} v${await publicClient.readContract({ address: ERC8004_TESTNET.reputationRegistry, abi: reputationAbi, functionName: "getVersion" })}, points at ${await publicClient.readContract({ address: ERC8004_TESTNET.reputationRegistry, abi: reputationAbi, functionName: "getIdentityRegistry" })}`);
  for (const id of Object.keys(STAFF)) {
    const entry = data.agents[id];
    if (!entry) {
      console.log(`${id}: not registered`);
      continue;
    }
    const agentId = BigInt(entry.agentId);
    const [owner, uri, wallet] = await Promise.all(["ownerOf", "tokenURI", "getAgentWallet"].map((functionName) => publicClient.readContract({ address: ERC8004_TESTNET.identityRegistry, abi: identityAbi, functionName, args: [agentId] })));
    console.log(`${id}: agent ${agentId} owner ${owner} wallet ${wallet}\n    uri ${uri}`);
    console.log(`    reputation ${JSON.stringify(await identity.reputation(agentId))}`);
    for (const row of await identity.feedback(agentId)) console.log(`    feedback #${row.index} from ${row.client}: ${row.value} ${row.tag1}/${row.tag2}${row.revoked ? " (revoked)" : ""}`);
  }
}

const [command, ...args] = process.argv.slice(2);
await assertTestnet();
if (command === "register") await register();
else if (command === "seed") await seed();
else if (command === "feedback") await feedback(...args);
else if (command === "status") await status();
else {
  console.error("usage: erc8004.mjs register | seed | feedback <satpam|analis|humas> <value> <tag1> <tag2> [feedbackURI] [endpoint] | status");
  process.exit(2);
}
