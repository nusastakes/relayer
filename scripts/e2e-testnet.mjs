#!/usr/bin/env node
// End-to-end check of the core loop on Monad testnet. It sends real testnet transactions.
//
//   RELAYER_PRIVATE_KEY=0x… node scripts/e2e-testnet.mjs                 # starts a local relayer; the key is also the mayor
//   RELAYER_URL=https://… node scripts/e2e-testnet.mjs                   # tests a hosted relayer; needs no key: the mayor is a
//                                                                         # new wallet that gets its MON from /gas-drip
//
// Steps: found a city (the relayer key acts as mayor) -> a brand-new resident with NO MON gets AUSD through the
// relayer's /faucet -> the resident signs an EIP-2612 permit -> the relayer submits depositWithPermit through /deposit
// -> the mayor moves half of the city into the simulated-yield adapter -> wait and read the simulated yield ->
// the resident withdraws everything through the relayer too, still without any MON.

import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildRelayerFromEnv, createHttpServer } from "../src/server.mjs";

const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const FACTORY = "0x6765F0C80F6a7D5EC7Af120d12e81628F641508E";
const MIRROR_IMPL = "0x25BcA4f0ea34F115Cb7c620626fBBa95647E8690";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const FEED = "0x707A675DDc976B0E9C6B520Dbd0326204F30d540";
const SOURCE_ID = "0x71809e1e29dc09210f61029b6e5b4f037fb332bdf7caa16cf9362c78c500926d";
const DEPOSIT = 100_000_000n; // 100 AUSD
const CITY_NAME = "E2E smoke test (ignore)";
const WAIT_FOR_YIELD_SECONDS = Number(process.env.WAIT_FOR_YIELD_SECONDS || 90);

const chain = defineChain({ id: 10143, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });

const factoryAbi = parseAbi([
  "function createCity(string name, string community, uint16 feeBps, address[] adapterImpls, string mapURI) returns (address vault)",
  "event CityCreated(address indexed vault, address indexed mayor, string name, string community, uint16 feeBps, string mapURI)",
]);
const vaultAbi = parseAbi([
  "function adapters() view returns (address[])",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function rebalance(address from, address to, uint256 amount, bytes32 planHash)",
  "function nonces(address) view returns (uint256)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function nonces(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const feedAbi = parseAbi(["function latest(bytes32) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)"]);
const mirrorAbi = parseAbi(["function principal() view returns (uint256)", "function owed() view returns (uint256)", "function totalAssets() view returns (uint256)", "function isSimulated() view returns (bool)"]);

const log = (...a) => console.log(...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const fmt = (n) => (Number(n) / 1e6).toFixed(6);

async function post(base, path, body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (res.status === 429 && json.retryAfterSeconds) {
      log(`  ${path}: busy (${json.error}); retrying in ${json.retryAfterSeconds}s`);
      await sleep(json.retryAfterSeconds + 1);
      continue;
    }
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }
  throw new Error(`${path}: still busy after retries`);
}

const REMOTE = process.env.RELAYER_URL?.replace(/\/$/, "");
let server;
let base = REMOTE;
if (!REMOTE) {
  const relayer = buildRelayerFromEnv();
  server = createHttpServer(relayer, { allowedOrigins: ["*"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const mayor = REMOTE ? privateKeyToAccount(generatePrivateKey()) : privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY);
const mayorWallet = createWalletClient({ account: mayor, chain, transport: http(RPC) });
const resident = privateKeyToAccount(generatePrivateKey());
const result = { chainId: 10143, mayor: mayor.address, resident: resident.address, txs: {} };

/** Monad needs balance >= gas limit x maxFeePerGas, so use a tight cap: 1.5x base fee plus tip. */
async function tightFees() {
  const block = await pub.getBlock();
  const tip = await pub.estimateMaxPriorityFeePerGas().catch(() => 0n);
  return { maxFeePerGas: (block.baseFeePerGas * 3n) / 2n + tip, maxPriorityFeePerGas: tip };
}

try {
  log("relayer:", base);
  log("health:", await (await fetch(base + "/health")).json());

  if (REMOTE) {
    log("\n0. the mayor is a new wallet with no MON: it asks the relayer for a gas drip");
    const drip = await post(base, "/gas-drip", { address: mayor.address });
    result.txs.gasDrip = drip.hash;
    log(`  mayor ${mayor.address} received ${drip.amountWei} wei (tx ${drip.hash}); balance now ${await pub.getBalance({ address: mayor.address })}`);
    await sleep(3);
  }

  log("\n1. mayor founds a city");
  const createArgs = [CITY_NAME, "E2E", 1000, [MIRROR_IMPL], "ipfs://e2e"];
  // Monad charges the gas LIMIT, so estimate instead of using a round number.
  const createGas = ((await pub.estimateContractGas({ address: FACTORY, abi: factoryAbi, functionName: "createCity", args: createArgs, account: mayor })) * 11n) / 10n;
  let hash = await mayorWallet.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "createCity", args: createArgs, gas: createGas, ...(await tightFees()) });
  let receipt = await pub.waitForTransactionReceipt({ hash });
  const [created] = parseEventLogs({ abi: factoryAbi, eventName: "CityCreated", logs: receipt.logs });
  const vault = created.args.vault;
  const [mirror] = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "adapters" });
  result.vault = vault;
  result.mirror = mirror;
  result.txs.createCity = hash;
  log(`  city ${vault}, mirror adapter ${mirror}, gasUsed ${receipt.gasUsed}, simulated: ${await pub.readContract({ address: mirror, abi: mirrorAbi, functionName: "isSimulated" })}`);

  log("\n2. a new resident with no MON asks the relayer for test AUSD");
  const mon = await pub.getBalance({ address: resident.address });
  log(`  resident ${resident.address}, MON balance ${mon}`);
  const faucet = await post(base, "/faucet", { address: resident.address });
  result.txs.faucet = faucet.hash;
  const ausd = await pub.readContract({ address: AUSD, abi: tokenAbi, functionName: "balanceOf", args: [resident.address] });
  log(`  faucet tx ${faucet.hash} ${faucet.status}; resident AUSD ${fmt(ausd)}`);

  log("\n3. resident signs a permit; the relayer pays gas for the deposit");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = await pub.readContract({ address: AUSD, abi: tokenAbi, functionName: "nonces", args: [resident.address] });
  const signature = await resident.signTypedData({
    domain: { name: "Agora Dollar", version: "1", chainId: 10143, verifyingContract: AUSD },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit",
    message: { owner: resident.address, spender: vault, value: DEPOSIT, nonce, deadline },
  });
  const r = "0x" + signature.slice(2, 66), s = "0x" + signature.slice(66, 130), v = parseInt(signature.slice(130, 132), 16);
  const dep = await post(base, "/deposit", { vault, owner: resident.address, assets: DEPOSIT.toString(), deadline: deadline.toString(), v, r, s });
  result.txs.deposit = dep.hash;
  const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [resident.address] });
  const monAfter = await pub.getBalance({ address: resident.address });
  log(`  deposit tx ${dep.hash} ${dep.status}, gasUsed ${dep.gasUsed}; shares minted to the resident: ${shares} (event says ${dep.shares} to ${dep.sharesOwner})`);
  log(`  resident MON after: ${monAfter} (still zero = gasless), city totalAssets ${fmt(await pub.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }))}`);
  if (shares === 0n || monAfter !== 0n) throw new Error("deposit did not behave as expected");

  log("\n4. mayor moves half of the city into the simulated-yield adapter");
  hash = await mayorWallet.writeContract({ address: vault, abi: vaultAbi, functionName: "rebalance", args: ["0x0000000000000000000000000000000000000000", mirror, DEPOSIT / 2n, "0x" + "00".repeat(31) + "01"], gas: 400_000n, ...(await tightFees()) });
  receipt = await pub.waitForTransactionReceipt({ hash });
  result.txs.rebalance = hash;
  log(`  rebalance tx ${hash} ${receipt.status}; adapter principal ${fmt(await pub.readContract({ address: mirror, abi: mirrorAbi, functionName: "principal" }))}`);

  const [apy] = await pub.readContract({ address: FEED, abi: feedAbi, functionName: "latest", args: [SOURCE_ID] });
  log(`\n5. waiting ${WAIT_FOR_YIELD_SECONDS}s for simulated yield (ApyFeed says ${apy} bps)`);
  const before = await pub.readContract({ address: mirror, abi: mirrorAbi, functionName: "totalAssets" });
  await sleep(WAIT_FOR_YIELD_SECONDS);
  const after = await pub.readContract({ address: mirror, abi: mirrorAbi, functionName: "totalAssets" });
  log(`  adapter totalAssets ${before} -> ${after} (raw units, 6 decimals): grew by ${after - before}`);
  result.yieldGrowthRawUnits = (after - before).toString();

  log("\n6. resident withdraws everything WITHOUT holding MON: signs a share permit, the relayer pays the gas");
  const claim = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [shares] });
  const wDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const shareNonce = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "nonces", args: [resident.address] });
  const wSig = await resident.signTypedData({
    domain: { name: CITY_NAME, version: "1", chainId: 10143, verifyingContract: vault },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit",
    message: { owner: resident.address, spender: vault, value: shares, nonce: shareNonce, deadline: wDeadline },
  });
  const wr = "0x" + wSig.slice(2, 66), ws = "0x" + wSig.slice(66, 130), wv = parseInt(wSig.slice(130, 132), 16);
  const wd = await post(base, "/withdraw", { vault, owner: resident.address, shares: shares.toString(), deadline: wDeadline.toString(), v: wv, r: wr, s: ws });
  result.txs.withdraw = wd.hash;
  const back = await pub.readContract({ address: AUSD, abi: tokenAbi, functionName: "balanceOf", args: [resident.address] });
  const startAusd = ausd; // 10,000 AUSD from the faucet, 100 deposited
  const monEnd = await pub.getBalance({ address: resident.address });
  log(`  withdraw tx ${wd.hash} ${wd.status}, gasUsed ${wd.gasUsed}; assets paid ${fmt(BigInt(wd.assets))} to ${wd.receiver}`);
  log(`  claim before ${fmt(claim)} AUSD; resident AUSD ${fmt(startAusd - DEPOSIT)} -> ${fmt(back)} (started with ${fmt(startAusd)}); resident MON at the end: ${monEnd}`);
  if (monEnd !== 0n) throw new Error("the resident ended up holding MON");
  if (wd.receiver.toLowerCase() !== resident.address.toLowerCase()) throw new Error("assets were not paid to the resident");
  result.depositedAssets = DEPOSIT.toString();
  result.assetsReturned = (back - (startAusd - DEPOSIT)).toString();
  if (back < startAusd - 1n) throw new Error("resident got back less than deposited");

  log("\nRESULT", JSON.stringify(result, null, 2));
  log("\nE2E OK");
} catch (e) {
  console.error("\nE2E FAILED:", e.shortMessage || e.message);
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  server?.close();
}
