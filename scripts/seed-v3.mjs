#!/usr/bin/env node
// Seeds a fresh v3 deployment on Monad testnet so the demo works end to end: founds the demo city, funds it, lists the
// team's agents (and the example community agent) on the AgentMarketplace contract, and has the mayor hire them through it.
//
//   set -a; . ../.env; set +a
//   node scripts/seed-v3.mjs            # idempotent: skips what already exists
//
// Addresses come from contracts/deployments/monad-testnet.json. Keys come from the environment and are never printed:
// DEPLOYER_PRIVATE_KEY (the mayor), ANALYST_PRIVATE_KEY, HUMAS_PRIVATE_KEY, COMMUNITY_AGENT_PRIVATE_KEY. Testnet only.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, erc20Abi, getAddress, http, keccak256, parseAbi, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = resolve(here, "../../contracts/deployments/monad-testnet.json");
const ERC8004 = resolve(here, "../deployments/erc8004-testnet.json");
const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const UNIT = 1_000_000n;
const WEEK = 7 * 24 * 3600;

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const factoryAbi = parseAbi(["function createCity(string name, string community, uint16 feeBps, address[] adapterImpls, string mapURI) returns (address)", "function cityCount() view returns (uint256)", "function isCity(address) view returns (bool)", "event CityCreated(address indexed vault, address indexed mayor, string name, string community, uint16 feeBps, string mapURI)"]);
const cityAbi = parseAbi(["function deposit(uint256 assets, address receiver) returns (uint256)", "function rebalance(address from, address to, uint256 amount, bytes32 planHash)", "function adapters() view returns (address[])", "function totalAssets() view returns (uint256)", "function setStyle(bytes32)", "function mayor() view returns (address)"]);
const marketAbi = parseAbi([
  "function list(uint256 agentId, bytes32 capability, address asset, uint128 price, uint32 period, string uri) returns (uint256)",
  "function hire(uint256 listingId, uint64 periods, uint256 maxTotal, address hook, bytes data) returns (uint64)",
  "function listingIdsOf(uint256 agentId) view returns (uint256[])",
  "function isHired(uint256 listingId, address client) view returns (bool)",
  "event Listed(uint256 indexed listingId, uint256 indexed agentId, address indexed seller, address asset, uint128 price, uint32 period, bytes32 capability)",
]);
const guardianAbi = parseAbi(["function isActiveAgent(address city, address agent, uint8 role) view returns (bool)"]);
const identityAbi = parseAbi(["function getAgentWallet(uint256) view returns (address)"]);
const CAPABILITY = { analis: keccak256(toBytes("nusastakes.city-staff.analis")), humas: keccak256(toBytes("nusastakes.city-staff.humas")) };

const log = (m) => console.log(m);
const wallet = (envVar) => {
  const key = process.env[envVar];
  if (!key) throw new Error(`${envVar} is not set`);
  const account = privateKeyToAccount(key);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC) }) };
};
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

const dep = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
const addr = (name) => dep.contracts[name].address;
const FACTORY = addr("CityFactory");
const GUARDIAN = addr("CityGuardian");
const MARKET = addr("AgentMarketplace");
const MIRROR = addr("MirrorYieldAdapter");
const ids = JSON.parse(readFileSync(ERC8004, "utf8"));
const mayor = wallet("DEPLOYER_PRIVATE_KEY");
const state = (dep.seed ??= {});

// 1. The demo city.
if (!state.demoCity) {
  const { hash, receipt } = await send(mayor, { address: FACTORY, abi: factoryAbi, functionName: "createCity", args: ["Satpam demo", "Nusastakes", 1000, [MIRROR], ""] });
  state.demoCity = getAddress(eventOf(receipt, factoryAbi, "CityCreated").args.vault);
  state.createCityTx = hash;
  log(`founded the demo city ${state.demoCity}, tx ${hash}`);
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(dep, null, 2)}\n`);
}
const CITY = state.demoCity;

// 2. Money in the city: 1,000 AUSD deposited by the mayor, half moved into the simulated-yield adapter.
const total = await publicClient.readContract({ address: CITY, abi: cityAbi, functionName: "totalAssets" });
if (total < 100n * UNIT) {
  const balance = await publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [mayor.account.address] });
  if (balance < 1000n * UNIT) throw new Error(`the mayor wallet holds ${balance} AUSD units; fund it from the faucet first`);
  await send(mayor, { address: AUSD, abi: erc20Abi, functionName: "approve", args: [CITY, 1000n * UNIT] });
  const deposit = await send(mayor, { address: CITY, abi: cityAbi, functionName: "deposit", args: [1000n * UNIT, mayor.account.address] });
  log(`mayor deposited 1000 AUSD, tx ${deposit.hash}`);
  const [adapter] = await publicClient.readContract({ address: CITY, abi: cityAbi, functionName: "adapters" });
  const move = await send(mayor, { address: CITY, abi: cityAbi, functionName: "rebalance", args: ["0x0000000000000000000000000000000000000000", adapter, 500n * UNIT, keccak256(toBytes("seed-v3"))] });
  log(`moved 500 AUSD into the adapter, tx ${move.hash}`);
}

// 3. The theme, stored on-chain.
if (!state.styleTx) {
  const code = `0x${Buffer.from("klasik.taman", "utf8").toString("hex").padEnd(64, "0")}`;
  state.styleTx = (await send(mayor, { address: CITY, abi: cityAbi, functionName: "setStyle", args: [code] })).hash;
  log(`set the city style on-chain, tx ${state.styleTx}`);
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(dep, null, 2)}\n`);
}

// 4. List each agent on the marketplace from its own wallet, then have the mayor hire it through the marketplace.
const agents = [
  { key: "analis", envVar: "ANALYST_PRIVATE_KEY", agentId: ids.agents.analis.agentId, price: 500_000n, role: 2 },
  { key: "humas", envVar: "HUMAS_PRIVATE_KEY", agentId: ids.agents.humas.agentId, price: 200_000n, role: 3 },
  { key: "community", envVar: "COMMUNITY_AGENT_PRIVATE_KEY", agentId: ids.community?.demo?.agentId, price: 100_000n, role: 2, capability: "analis" },
];
state.listings ??= {};
for (const a of agents) {
  if (a.agentId === undefined) continue;
  const w = wallet(a.envVar);
  const capability = CAPABILITY[a.capability ?? a.key];
  if (state.listings[a.key] === undefined) {
    const { hash, receipt } = await send(w, { address: MARKET, abi: marketAbi, functionName: "list", args: [BigInt(a.agentId), capability, AUSD, a.price, WEEK, ""] });
    state.listings[a.key] = eventOf(receipt, marketAbi, "Listed").args.listingId.toString();
    log(`listed agent ${a.agentId} (${a.key}) as listing ${state.listings[a.key]} at ${a.price} units per week, tx ${hash}`);
    writeFileSync(DEPLOYMENTS, `${JSON.stringify(dep, null, 2)}\n`);
  }
  const agentWallet = await publicClient.readContract({ address: ids.identityRegistry ?? "0x8004A818BFB912233c491871b3d84c89A494BD9e", abi: identityAbi, functionName: "getAgentWallet", args: [BigInt(a.agentId)] });
  const hired = await publicClient.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: "isActiveAgent", args: [CITY, agentWallet, a.role] });
  if (!hired) {
    await send(mayor, { address: AUSD, abi: erc20Abi, functionName: "approve", args: [MARKET, a.price] });
    const { hash } = await send(mayor, { address: MARKET, abi: marketAbi, functionName: "hire", args: [BigInt(state.listings[a.key]), 1n, a.price, GUARDIAN, encodeAbiParameters([{ type: "address" }], [CITY])] });
    log(`mayor hired ${a.key} through the marketplace, tx ${hash}`);
    state[`hire_${a.key}`] = hash;
    writeFileSync(DEPLOYMENTS, `${JSON.stringify(dep, null, 2)}\n`);
  }
}
log("seed done");
