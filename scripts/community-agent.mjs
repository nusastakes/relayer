#!/usr/bin/env node
// Walks one THIRD-PARTY agent through the whole staff exchange on Monad testnet, the way an outside developer would:
// register in the ERC-8004 Identity Registry, publish a registration file, apply to the exchange, get hired by a mayor,
// propose a rebalance, and have the mayor approve it. The agent is a throwaway example (its card says so).
//
//   set -a; . ../.env; set +a
//   node scripts/community-agent.mjs run        # all steps, safe to rerun (skips what is already done)
//   node scripts/community-agent.mjs status
//
// Keys: the agent's own key is created on first run and appended to ../.env as COMMUNITY_AGENT_PRIVATE_KEY (never
// printed); the mayor is DEPLOYER_PRIVATE_KEY. Testnet only.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, erc20Abi, getAddress, http, keccak256, parseAbi, parseEther, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ERC8004_TESTNET, identityAbi } from "../src/erc8004.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(here, "../../.env");
const DEPLOYMENTS = resolve(here, "../deployments/erc8004-testnet.json");
const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const BASE = (process.env.RELAYER_URL || "https://relayer-production-39e1.up.railway.app").replace(/\/+$/, "");
const GUARDIAN = "0x083899bEE8138E5f951db568926393FDb1F418A2";
const CITY = process.env.DEMO_CITY || "0x887AC9965980f680dEbd08A30e2FB33aE99F2397";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const REGISTRY_REF = `eip155:10143:${ERC8004_TESTNET.identityRegistry}`;

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const guardianAbi = parseAbi([
  "function grantAgent(address city, address agent, uint8 role, uint64 expiry)",
  "function propose(address city, address from, address to, uint256 amount, bytes32 planHash) returns (uint256 id)",
  "function approve(address city, uint256 id)",
  "function isActiveAgent(address city, address agent, uint8 role) view returns (bool)",
  "event ProposalCreated(uint256 indexed id, address indexed city, address indexed proposer, address from, address to, uint256 amount, bytes32 planHash)",
]);
const cityAbi = parseAbi(["function adapters() view returns (address[])", "function mayor() view returns (address)"]);

const log = (m) => console.log(m);
const load = () => JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
function save(data) {
  mkdirSync(dirname(DEPLOYMENTS), { recursive: true });
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(data, null, 2)}\n`);
}
function wallet(key) {
  const account = privateKeyToAccount(key);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC) }) };
}
async function send(w, request) {
  const gas = ((await publicClient.estimateContractGas({ ...request, account: w.account })) * 12n) / 10n;
  const block = await publicClient.getBlock();
  const tip = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n);
  const hash = await w.client.writeContract({ ...request, gas, maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + tip, maxPriorityFeePerGas: tip });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return { hash, receipt };
}
const eventOf = (receipt, abi, name) => receipt.logs.map((l) => { try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === name);
const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

/** The registration file of the example agent. It names itself an example so nobody mistakes it for a real service. */
function card(agentId) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Contoh Analis Komunitas (demo)",
    description: "EXAMPLE third-party analyst used to test the Nusastakes staff exchange. It proposes tiny rebalances for the demo city and is not a real service.",
    services: [{ name: "web", endpoint: "https://github.com/nusastakes/relayer/blob/main/AGENTS.md" }],
    x402Support: false,
    active: true,
    registrations: [{ agentId: Number(agentId), agentRegistry: REGISTRY_REF }],
    supportedTrust: ["reputation"],
    nusastakes: { capability: "nusastakes.city-staff", roleId: 2, role: "ANALIS", pricing: { model: "free" }, hire: "CityGuardian.grantAgent(city, agent, 2, expiry), called by the city's mayor" },
  };
}
const asDataUri = (obj) => `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString("base64")}`;

function agentKey() {
  if (process.env.COMMUNITY_AGENT_PRIVATE_KEY) return process.env.COMMUNITY_AGENT_PRIVATE_KEY;
  const key = generatePrivateKey();
  appendFileSync(ENV_FILE, `\n# Example third-party agent for the staff exchange demo (testnet only)\nCOMMUNITY_AGENT_PRIVATE_KEY=${key}\n`);
  process.env.COMMUNITY_AGENT_PRIVATE_KEY = key;
  log("created a new agent key and saved it to .env (not printed)");
  return key;
}

async function run() {
  if ((await publicClient.getChainId()) !== 10143) throw new Error("testnet only");
  const mayor = wallet(process.env.DEPLOYER_PRIVATE_KEY);
  const agent = wallet(agentKey());
  const data = load();
  data.community ??= {};
  const mine = (data.community.demo ??= {});
  log(`agent wallet ${agent.account.address}`);

  // 0. Gas for the agent (a testnet transfer from the mayor wallet).
  if ((await publicClient.getBalance({ address: agent.account.address })) < parseEther("0.2")) {
    const hash = await mayor.client.sendTransaction({ to: agent.account.address, value: parseEther("0.3") });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`funded the agent with 0.3 MON, tx ${hash}`);
  }

  // 1. Register, then point the identity at the registration file (the file must name the id, which exists only after registering).
  if (mine.agentId === undefined) {
    const { hash, receipt } = await send(agent, { address: ERC8004_TESTNET.identityRegistry, abi: identityAbi, functionName: "register", args: ["data:application/json,{}"] });
    mine.agentId = eventOf(receipt, identityAbi, "Registered").args.agentId.toString();
    mine.wallet = getAddress(agent.account.address);
    mine.registerTx = hash;
    save(data);
    log(`registered as agent ${mine.agentId}, tx ${hash}`);
  }
  const current = await publicClient.readContract({ address: ERC8004_TESTNET.identityRegistry, abi: identityAbi, functionName: "tokenURI", args: [BigInt(mine.agentId)] });
  if (!current.startsWith("data:application/json;base64,")) {
    const { hash } = await send(agent, { address: ERC8004_TESTNET.identityRegistry, abi: identityAbi, functionName: "setAgentURI", args: [BigInt(mine.agentId), asDataUri(card(mine.agentId))] });
    mine.setUriTx = hash;
    save(data);
    log(`published the registration file, tx ${hash}`);
  }

  // 2. Apply to the exchange. The relayer checks everything itself.
  const applied = await post("/marketplace/apply", { agentId: mine.agentId });
  log(`apply -> HTTP ${applied.status}: ${applied.status === 200 ? `listed (updated: ${applied.body.updated}), wallet ${applied.body.agent.wallet}` : JSON.stringify(applied.body)}`);
  if (applied.status !== 200) throw new Error("the exchange refused the application");

  // 3. The mayor hires the agent for seven days.
  const hired = await publicClient.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: "isActiveAgent", args: [CITY, agent.account.address, 2] });
  if (!hired) {
    const { hash } = await send(mayor, { address: GUARDIAN, abi: guardianAbi, functionName: "grantAgent", args: [CITY, agent.account.address, 2, BigInt(Math.floor(Date.now() / 1000) + 7 * 86400)] });
    mine.hireTx = hash;
    save(data);
    log(`mayor hired the agent in ${CITY}, tx ${hash}`);
  }
  const market = await (await fetch(`${BASE}/marketplace?city=${CITY}`)).json();
  const listed = market.agents.find((a) => a.erc8004?.agentId === mine.agentId && a.source === "community");
  log(`exchange says: hiredInCity ${listed?.hiredInCity}, status ${listed?.status}, role ${listed?.role}`);

  // 4. The agent proposes moving 1 AUSD from idle into the city's adapter, and the mayor approves it.
  if (!mine.proposeTx) {
    const [adapter] = await publicClient.readContract({ address: CITY, abi: cityAbi, functionName: "adapters" });
    const idle = await publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [CITY] });
    if (idle < 2_000_000n) throw new Error("the demo city has too little idle cash for the example proposal");
    const planHash = keccak256(stringToHex(JSON.stringify({ agent: mine.agentId, from: "idle", to: adapter, amount: "1000000", reason: "example proposal from a third-party agent" })));
    const proposed = await send(agent, { address: GUARDIAN, abi: guardianAbi, functionName: "propose", args: [CITY, "0x0000000000000000000000000000000000000000", adapter, 1_000_000n, planHash] });
    mine.proposeTx = proposed.hash;
    mine.proposalId = eventOf(proposed.receipt, guardianAbi, "ProposalCreated").args.id.toString();
    save(data);
    log(`agent proposed (id ${mine.proposalId}), tx ${proposed.hash}`);
    const approved = await send(mayor, { address: GUARDIAN, abi: guardianAbi, functionName: "approve", args: [CITY, BigInt(mine.proposalId)] });
    mine.approveTx = approved.hash;
    save(data);
    log(`mayor approved it, tx ${approved.hash}`);
  }
  log("done");
}

async function status() {
  const data = load();
  const mine = data.community?.demo;
  log(JSON.stringify(mine ?? "no community demo agent yet", null, 2));
  const market = await (await fetch(`${BASE}/marketplace?city=${CITY}`)).json();
  for (const a of market.agents) log(`${a.source.padEnd(9)} ${a.id.padEnd(14)} role ${a.role.padEnd(6)} pricing ${a.pricing.model.padEnd(6)} reputation ${JSON.stringify(a.reputation)} hired ${a.hiredInCity}`);
}

const command = process.argv[2];
if (command === "run") await run();
else if (command === "status") await status();
else {
  console.error("usage: community-agent.mjs run | status");
  process.exit(2);
}
