#!/usr/bin/env node
// Proves `AgentMarketplace.hireWithPermit` with the REAL testnet AUSD: the mayor signs an EIP-2612 permit (no approve
// transaction), and one transaction pays the agent's wallet, pays the platform fee, and makes the guardian grant the role.
//
//   set -a; . ../.env; set +a; node scripts/hire-permit-check.mjs [listingId]     # default: listing 2, the example community agent
//
// It renews an existing hire of the demo city (so it adds a week and costs the listing price). Testnet only.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, erc20Abi, getAddress, http, parseAbi, parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(resolve(here, "../../contracts/deployments/monad-testnet.json"), "utf8"));
const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const MARKET = dep.contracts.AgentMarketplace.address;
const GUARDIAN = dep.contracts.CityGuardian.address;
const CITY = dep.seed.demoCity;
const LISTING = BigInt(process.argv[2] ?? dep.seed.listings.community);

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
const marketAbi = parseAbi([
  "struct Listing { uint256 agentId; address seller; address asset; uint128 price; uint32 period; bytes32 capability; bool active; string uri; }",
  "function getListing(uint256) view returns (Listing)",
  "function termsHash(uint256) view returns (bytes32)",
  "function hiredUntil(uint256,address) view returns (uint64)",
  "function treasury() view returns (address)",
  "function hireWithPermit(uint256 listingId, uint64 periods, bytes32 expectedTerms, address hook, bytes data, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint64)",
]);
const tokenAbi = parseAbi(["function nonces(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const identityAbi = parseAbi(["function getAgentWallet(uint256) view returns (address)"]);
const guardianAbi = parseAbi(["function agents(address city, address agent) view returns (uint8 role, uint64 expiry)"]);
const bal = (who) => publicClient.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [who] });

const listing = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "getListing", args: [LISTING] });
const agentWallet = await publicClient.readContract({ address: "0x8004A818BFB912233c491871b3d84c89A494BD9e", abi: identityAbi, functionName: "getAgentWallet", args: [listing.agentId] });
const treasury = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "treasury" });
const total = listing.price;
const allowanceBefore = await publicClient.readContract({ address: AUSD, abi: tokenAbi, functionName: "allowance", args: [account.address, MARKET] });
console.log(`listing ${LISTING}: agent ${listing.agentId}, price ${total} units, agent wallet ${agentWallet}; allowance for the marketplace before: ${allowanceBefore}`);
if (allowanceBefore !== 0n) throw new Error("expected a zero allowance so that the permit is what pays; clear it first");

const before = { agent: await bal(agentWallet), payer: await bal(account.address), treasury: await bal(treasury) };
const [, until0] = await publicClient.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: "agents", args: [CITY, agentWallet] });
const nonce = await publicClient.readContract({ address: AUSD, abi: tokenAbi, functionName: "nonces", args: [account.address] });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const signature = await account.signTypedData({
  domain: { name: "Agora Dollar", version: "1", chainId: 10143, verifyingContract: AUSD },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit",
  message: { owner: account.address, spender: MARKET, value: total, nonce, deadline },
});
const { v, r, s } = parseSignature(signature);
const terms = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "termsHash", args: [LISTING] });
const args = [LISTING, 1n, terms, GUARDIAN, encodeAbiParameters([{ type: "address" }], [CITY]), deadline, Number(v), r, s];
const gas = ((await publicClient.estimateContractGas({ address: MARKET, abi: marketAbi, functionName: "hireWithPermit", args, account })) * 12n) / 10n;
const block = await publicClient.getBlock();
const tip = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n);
const hash = await wallet.writeContract({ address: MARKET, abi: marketAbi, functionName: "hireWithPermit", args, gas, maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + tip, maxPriorityFeePerGas: tip });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`hireWithPermit tx ${hash}: ${receipt.status}, gas used ${receipt.gasUsed}`);

const after = { agent: await bal(agentWallet), payer: await bal(account.address), treasury: await bal(treasury) };
const [role, until1] = await publicClient.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: "agents", args: [CITY, agentWallet] });
const allowanceAfter = await publicClient.readContract({ address: AUSD, abi: tokenAbi, functionName: "allowance", args: [account.address, MARKET] });
console.log(`agent wallet +${after.agent - before.agent}; the payer paid ${before.payer - after.payer} net (the platform treasury is the payer's own wallet in this deployment, so the 5% fee comes back to it)`);
console.log(`guardian role ${role}, expiry ${until0} -> ${until1} (+${until1 - until0} s); allowance after: ${allowanceAfter}`);
if (receipt.status !== "success" || after.agent - before.agent !== (total * 95n) / 100n || until1 <= until0) process.exitCode = 1;
