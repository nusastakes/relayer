#!/usr/bin/env node
// APY keeper: reads the real APY of a mainnet AUSD vault and writes it to the testnet ApyFeed, so the simulated yield
// of MirrorYieldAdapter follows the real market.
//
//   node src/keeper.mjs --dry                 # compute and print, send nothing
//   node src/keeper.mjs                       # compute and write once
//   node src/keeper.mjs --loop --interval 3600
//
// Primary source: the rise of the vault's share price (convertToAssets) between two mainnet blocks, which anyone can
// re-check onchain. Fallback: the `netApy` field of Morpho's GraphQL API. The only secret is RELAYER_PRIVATE_KEY,
// read from the environment (never from a tracked file).

import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { apyFractionToBps, computeApyBps, findBlockAtOrBefore, shouldWrite } from "./apy.mjs";

const DEFAULTS = {
  mainnetRpc: "https://rpc.monad.xyz",
  testnetRpc: "https://testnet-rpc.monad.xyz",
  // Morpho "Grove x Steakhouse High Yield AUSD" on Monad mainnet (MetaMorpho V1, 18-decimal shares, 6-decimal asset).
  sourceVault: "0x32841A8511D5c2c5b253f45668780B99139e476D",
  sourceId: "0x71809e1e29dc09210f61029b6e5b4f037fb332bdf7caa16cf9362c78c500926d",
  // ApyFeed on Monad testnet (contracts/deployments/monad-testnet.json).
  feed: "0x707A675DDc976B0E9C6B520Dbd0326204F30d540",
  morphoApi: "https://blue-api.morpho.org/graphql",
};

/** 1e30 raw share units: large enough that convertToAssets keeps about 12 significant digits for a 6-decimal asset. */
const SHARE_PROBE = 10n ** 30n;

const vaultAbi = parseAbi(["function convertToAssets(uint256 shares) view returns (uint256)"]);
const feedAbi = parseAbi([
  "function setApy(bytes32 sourceId, uint32 apyBps, uint64 observedAt)",
  "function latest(bytes32 sourceId) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)",
  "function updater() view returns (address)",
]);

const chain = (id, name, rpc) =>
  defineChain({ id, name, nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

function parseArgs(argv) {
  const o = { dry: false, loop: false, intervalSec: 3600, windowDays: 3, minChangeBps: 5n, maxAgeSec: 6 * 3600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") o.dry = true;
    else if (a === "--loop") o.loop = true;
    else if (a === "--interval") o.intervalSec = Number(argv[++i]);
    else if (a === "--window-days") o.windowDays = Number(argv[++i]);
    else if (a === "--min-change-bps") o.minChangeBps = BigInt(argv[++i]);
    else if (a === "--max-age-sec") o.maxAgeSec = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const cfg = () => ({
  mainnetRpc: process.env.MONAD_MAINNET_RPC || DEFAULTS.mainnetRpc,
  testnetRpc: process.env.MONAD_TESTNET_RPC || DEFAULTS.testnetRpc,
  sourceVault: process.env.APY_SOURCE_VAULT || DEFAULTS.sourceVault,
  sourceId: process.env.APY_SOURCE_ID || DEFAULTS.sourceId,
  feed: process.env.APY_FEED_ADDRESS || DEFAULTS.feed,
  morphoApi: process.env.MORPHO_API || DEFAULTS.morphoApi,
});

/** Primary: price rise over the window. Returns { bps, source, detail }. */
async function apyFromChain(c, windowDays) {
  const main = createPublicClient({ chain: chain(143, "Monad", c.mainnetRpc), transport: http(c.mainnetRpc) });
  const latest = await main.getBlock();
  const target = latest.timestamp - BigInt(Math.round(windowDays * 86400));
  const getTs = async (n) => (await main.getBlock({ blockNumber: n })).timestamp;
  const earliest = latest.number > 5_000_000n ? latest.number - 5_000_000n : 1n;
  const b0 = await findBlockAtOrBefore(getTs, latest.number, target, earliest);
  const block0 = await main.getBlock({ blockNumber: b0 });
  const read = (blockNumber) =>
    main.readContract({ address: c.sourceVault, abi: vaultAbi, functionName: "convertToAssets", args: [SHARE_PROBE], blockNumber });
  const [p0, p1] = await Promise.all([read(b0), read(latest.number)]);
  const dt = latest.timestamp - block0.timestamp;
  return {
    bps: computeApyBps(p0, p1, dt),
    source: "onchain share price",
    observedAt: latest.timestamp,
    detail: `blocks ${b0}..${latest.number}, ${dt}s, price ${p0} -> ${p1}`,
  };
}

/** Fallback: Morpho's own netApy. */
async function apyFromApi(c) {
  const res = await fetch(c.morphoApi, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "query($a:String!,$c:Int!){ vaultByAddress(address:$a, chainId:$c){ state{ netApy } } }",
      variables: { a: c.sourceVault, c: 143 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`);
  const json = await res.json();
  const netApy = json?.data?.vaultByAddress?.state?.netApy;
  if (typeof netApy !== "number") throw new Error("Morpho API returned no netApy");
  return { bps: apyFractionToBps(netApy), source: "Morpho API netApy", observedAt: BigInt(Math.floor(Date.now() / 1000)), detail: `netApy ${netApy}` };
}

async function reading(c, o) {
  try {
    return await apyFromChain(c, o.windowDays);
  } catch (e) {
    console.warn(`onchain reading failed (${e.shortMessage || e.message}); using the Morpho API instead`);
    return apyFromApi(c);
  }
}

async function step(o) {
  const c = cfg();
  const r = await reading(c, o);
  console.log(`[${new Date().toISOString()}] APY ${r.bps} bps (${(Number(r.bps) / 100).toFixed(2)}%) from ${r.source}: ${r.detail}`);
  if (o.dry) return;

  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) throw new Error("RELAYER_PRIVATE_KEY is not set");
  const account = privateKeyToAccount(key);
  const testnet = chain(10143, "Monad Testnet", c.testnetRpc);
  const pub = createPublicClient({ chain: testnet, transport: http(c.testnetRpc) });
  const wallet = createWalletClient({ account, chain: testnet, transport: http(c.testnetRpc) });

  const updater = await pub.readContract({ address: c.feed, abi: feedAbi, functionName: "updater" });
  if (updater.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`${account.address} is not the feed updater (${updater}); the owner must call setUpdater first`);
  }
  const [curBps, curObserved] = await pub.readContract({ address: c.feed, abi: feedAbi, functionName: "latest", args: [c.sourceId] });
  const head = await pub.getBlock();
  // The feed refuses observations from the future or older than the stored one.
  const observedAt = r.observedAt < head.timestamp ? r.observedAt : head.timestamp;
  if (observedAt <= BigInt(curObserved) && curObserved !== 0n) {
    console.log("nothing newer than the stored observation; skipping");
    return;
  }
  const age = Number(head.timestamp - BigInt(curObserved));
  if (!shouldWrite({ newBps: r.bps, currentBps: BigInt(curBps), ageSeconds: curObserved === 0n ? Infinity : age, minChangeBps: o.minChangeBps, maxAgeSeconds: o.maxAgeSec })) {
    console.log(`feed already has ${curBps} bps from ${age}s ago; change below ${o.minChangeBps} bps, skipping`);
    return;
  }
  const hash = await wallet.writeContract({ address: c.feed, abi: feedAbi, functionName: "setApy", args: [c.sourceId, Number(r.bps), observedAt] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`setApy(${r.bps} bps) tx ${hash} status ${receipt.status} gasUsed ${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error("setApy transaction reverted");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.loop) return step(o);
  for (;;) {
    try {
      await step(o);
    } catch (e) {
      console.error(`step failed: ${e.shortMessage || e.message}`);
    }
    await new Promise((r) => setTimeout(r, o.intervalSec * 1000));
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
