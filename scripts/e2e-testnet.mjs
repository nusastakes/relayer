#!/usr/bin/env node
// End-to-end check of the core loop on Monad testnet. It sends real testnet transactions.
//
//   RELAYER_PRIVATE_KEY=0x… node scripts/e2e-testnet.mjs
//
// Steps: found a city (the relayer key acts as mayor) -> a brand-new resident with NO MON gets AUSD through the
// relayer's /faucet -> the resident signs an EIP-2612 permit -> the relayer submits depositWithPermit through /deposit
// -> the mayor moves half of the city into the simulated-yield adapter -> wait and read the simulated yield ->
// the resident (after a small gas top-up) redeems everything.

import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildRelayerFromEnv, createHttpServer } from "../src/server.mjs";

const RPC = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const FACTORY = "0xA54D964a4bF13be1E5AF05D5c7290f275f13B24C";
const MIRROR_IMPL = "0xdB96a6a8B70034c0Ef24170d3B4d5E2320FaeA60";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const FEED = "0xaA223d6F2047df4D4f47626f65e6873419524fe6";
const SOURCE_ID = "0x71809e1e29dc09210f61029b6e5b4f037fb332bdf7caa16cf9362c78c500926d";
const DEPOSIT = 100_000_000n; // 100 AUSD
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
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
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

const relayer = buildRelayerFromEnv();
const server = createHttpServer(relayer, { allowedOrigin: "*" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const mayor = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY);
const mayorWallet = createWalletClient({ account: mayor, chain, transport: http(RPC) });
const resident = privateKeyToAccount(generatePrivateKey());
const residentWallet = createWalletClient({ account: resident, chain, transport: http(RPC) });
const result = { chainId: 10143, mayor: mayor.address, resident: resident.address, txs: {} };

try {
  log("health:", await (await fetch(base + "/health")).json());

  log("\n1. mayor founds a city");
  let hash = await mayorWallet.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "createCity", args: ["E2E smoke test (ignore)", "", 1000, [MIRROR_IMPL], ""], gas: 4_000_000n });
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
  hash = await mayorWallet.writeContract({ address: vault, abi: vaultAbi, functionName: "rebalance", args: ["0x0000000000000000000000000000000000000000", mirror, DEPOSIT / 2n, "0x" + "00".repeat(31) + "01"], gas: 600_000n });
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

  log("\n6. resident (after a small gas top-up from the relayer) redeems everything");
  hash = await mayorWallet.sendTransaction({ to: resident.address, value: 10n ** 17n });
  await pub.waitForTransactionReceipt({ hash });
  // A freshly funded wallet needs a few seconds before the network accepts its first transaction.
  await sleep(5);
  const claim = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [shares] });
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await residentWallet.writeContract({ address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, resident.address, resident.address], gas: 800_000n });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      log(`  first transaction of the new wallet was refused (${(e.shortMessage || e.message).split("\n")[0]}); retrying in 4s (${attempt}/3)`);
      await sleep(4);
    }
  }
  receipt = await pub.waitForTransactionReceipt({ hash });
  result.txs.redeem = hash;
  const back = await pub.readContract({ address: AUSD, abi: tokenAbi, functionName: "balanceOf", args: [resident.address] });
  const startAusd = ausd; // 10,000 AUSD from the faucet, 100 deposited
  log(`  redeem tx ${hash} ${receipt.status}; claim before ${fmt(claim)} AUSD; resident AUSD ${fmt(startAusd - DEPOSIT)} -> ${fmt(back)} (started with ${fmt(startAusd)})`);
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
  server.close();
}
