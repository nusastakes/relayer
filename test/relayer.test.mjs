import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { HttpError, Mutex, createRateLimiter, parseDepositBody, parseFaucetBody, parseWithdrawBody } from "../src/guards.mjs";
import { createRelayer, vaultAbi } from "../src/relayer.mjs";

const ADDR = (n) => "0x" + n.toString(16).padStart(40, "0");
const OWNER = ADDR(0xa11ce);
const VAULT = ADDR(0xc1710);
const FACTORY = ADDR(0xfac7);
const FAUCET = ADDR(0xfa0c);
const RELAYER = ADDR(0x7e1a);
const R = "0x" + "11".repeat(32);
const S = "0x" + "22".repeat(32);

const goodBody = (over = {}) => ({ vault: VAULT, owner: OWNER, assets: "100000000", deadline: "4102444800", v: 27, r: R, s: S, ...over });

// ---------------------------------------------------------------- validation

test("deposit body: accepts a complete body and converts types", () => {
  const b = parseDepositBody(goodBody({ v: 28 }));
  assert.equal(b.assets, 100000000n);
  assert.equal(b.deadline, 4102444800n);
  assert.equal(b.v, 28);
});

test("deposit body: v given as recovery id 0 or 1 becomes 27 or 28", () => {
  assert.equal(parseDepositBody(goodBody({ v: 0 })).v, 27);
  assert.equal(parseDepositBody(goodBody({ v: 1 })).v, 28);
});

for (const [name, over] of [
  ["bad vault", { vault: "0x123" }],
  ["bad owner", { owner: "not an address" }],
  ["zero assets", { assets: "0" }],
  ["negative assets", { assets: "-5" }],
  ["decimal assets", { assets: "1.5" }],
  ["v out of range", { v: 29 }],
  ["short r", { r: "0x1234" }],
  ["missing s", { s: undefined }],
]) {
  test(`deposit body: rejects ${name}`, () => {
    assert.throws(() => parseDepositBody(goodBody(over)), (e) => e instanceof HttpError && e.status === 400);
  });
}

test("deposit body: rejects a non-object", () => {
  assert.throws(() => parseDepositBody(null), HttpError);
  assert.throws(() => parseDepositBody("x"), HttpError);
});

test("withdraw body: takes `shares`, rejects zero or missing, and ignores a stray `assets`", () => {
  const body = { vault: VAULT, owner: OWNER, shares: "5", deadline: "4102444800", v: 28, r: R, s: S };
  const b = parseWithdrawBody(body);
  assert.equal(b.shares, 5n);
  assert.equal("assets" in b, false);
  assert.throws(() => parseWithdrawBody({ ...body, shares: "0" }), /shares must be greater than zero/);
  assert.throws(() => parseWithdrawBody({ ...body, shares: undefined }), /shares must be a non-negative integer/);
  assert.throws(() => parseWithdrawBody({ ...body, shares: undefined, assets: "5" }), /shares/);
});

test("faucet body", () => {
  assert.equal(parseFaucetBody({ address: OWNER }).address, OWNER);
  assert.throws(() => parseFaucetBody({ address: "0x1" }), HttpError);
});

// ---------------------------------------------------------------- guards

test("rate limiter: allows `max` per window, then blocks, then resets", () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(rl.hit("a"), true);
  assert.equal(rl.hit("a"), true);
  assert.equal(rl.hit("a"), false);
  assert.equal(rl.hit("b"), true, "keys are independent");
  assert.equal(rl.retryAfterMs("a"), 1000);
  t = 1000;
  assert.equal(rl.hit("a"), true);
});

test("mutex runs tasks strictly one after another, even when one fails", async () => {
  const m = new Mutex();
  const order = [];
  const slow = m.run(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("slow");
  });
  const failing = m.run(async () => {
    order.push("failing");
    throw new Error("boom");
  });
  const last = m.run(async () => order.push("last"));
  await assert.rejects(failing, /boom/);
  await Promise.all([slow, last]);
  assert.deepEqual(order, ["slow", "failing", "last"]);
});

// ---------------------------------------------------------------- relayer logic with fake clients

function depositLog(shares) {
  const topics = encodeEventTopics({ abi: vaultAbi, eventName: "Deposit", args: { sender: OWNER, owner: OWNER } });
  const data = encodeAbiParameters(parseAbi(["function f(uint256 assets, uint256 shares)"])[0].inputs, [100000000n, shares]);
  return { address: VAULT, topics, data, blockNumber: 1n, transactionHash: "0x" + "ab".repeat(32), transactionIndex: 0, blockHash: "0x" + "cd".repeat(32), logIndex: 0, removed: false };
}

function fakes({ isCity = true, room = 10n ** 12n, balance = 10n ** 18n, recipientBalance = 0n, estimate = 200_000n, simulateError = null, estimateError = null } = {}) {
  const calls = { written: [], estimates: [] };
  const publicClient = {
    getBalance: async ({ address }) => (address === RELAYER ? balance : recipientBalance),
    getBlock: async () => ({ number: 123n, baseFeePerGas: 100_000_000_000n }),
    estimateMaxPriorityFeePerGas: async () => 1_000_000_000n,
    readContract: async ({ functionName }) => (functionName === "isCity" ? isCity : room),
    simulateContract: async () => {
      if (simulateError) throw new Error(simulateError);
    },
    estimateContractGas: async (req) => {
      calls.estimates.push(req);
      if (estimateError) throw new Error(estimateError);
      return estimate;
    },
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 150_000n, logs: [depositLog(123456n)] }),
  };
  const walletClient = {
    account: { address: RELAYER },
    writeContract: async (req) => {
      calls.written.push(req);
      return "0x" + "ee".repeat(32);
    },
    sendTransaction: async (req) => {
      calls.sent = [...(calls.sent || []), req];
      return "0x" + "dd".repeat(32);
    },
  };
  return { publicClient, walletClient, calls };
}

const relayerWith = (opts, over = {}) => {
  const f = fakes(opts);
  const relayer = createRelayer({ ...f, config: { factory: FACTORY, faucet: FAUCET, ...over }, now: () => 1_000_000_000_000 });
  return { relayer, ...f };
};

test("deposit: sends depositWithPermit for the signer, with an explicit gas limit near the estimate", async () => {
  const { relayer, calls } = relayerWith();
  const out = await relayer.deposit(goodBody());
  assert.equal(out.status, "success");
  assert.equal(out.shares, "123456");
  assert.equal(out.sharesOwner.toLowerCase(), OWNER.toLowerCase());
  assert.equal(calls.written.length, 1);
  const tx = calls.written[0];
  assert.equal(tx.functionName, "depositWithPermit");
  assert.equal(tx.args[0], OWNER, "the owner, not the relayer, is who the vault credits");
  assert.equal(tx.gas, 250_000n, "estimate 200k x 125%");
});

test("deposit: gas limit is capped", async () => {
  const { relayer, calls } = relayerWith({ estimate: 5_000_000n });
  await relayer.deposit(goodBody());
  assert.equal(calls.written[0].gas, 1_500_000n);
});

test("deposit: refuses a vault the factory did not create", async () => {
  const { relayer, calls } = relayerWith({ isCity: false });
  await assert.rejects(relayer.deposit(goodBody()), (e) => e.status === 400 && /factory/.test(e.message));
  assert.equal(calls.written.length, 0);
});

test("deposit: refuses an expired or imminent deadline", async () => {
  const { relayer } = relayerWith();
  await assert.rejects(relayer.deposit(goodBody({ deadline: "1000000000" })), /deadline/);
  await assert.rejects(relayer.deposit(goodBody({ deadline: "1000000005" })), /deadline/);
});

test("deposit: refuses amounts above the relayer limit and above the city's room", async () => {
  const { relayer } = relayerWith({}, { maxAssets: 50_000_000n });
  await assert.rejects(relayer.deposit(goodBody()), /relayer limit/);
  const small = relayerWith({ room: 10n }).relayer;
  await assert.rejects(small.deposit(goodBody()), /room/);
});

test("deposit: does not send when the transaction would fail (bad signature, no allowance)", async () => {
  const { relayer, calls } = relayerWith({ estimateError: "execution reverted: ERC20InsufficientAllowance" });
  await assert.rejects(relayer.deposit(goodBody()), (e) => e.status === 400 && /would fail/.test(e.message));
  assert.equal(calls.written.length, 0);
});

test("deposit: stops when the relayer is out of gas funds", async () => {
  const { relayer, calls } = relayerWith({ balance: 1n });
  await assert.rejects(relayer.deposit(goodBody()), (e) => e.status === 503);
  assert.equal(calls.written.length, 0);
});

test("deposit: uses a tight maxFeePerGas (1.5x base fee + tip) and checks the balance against gas x maxFee", async () => {
  const { relayer, calls } = relayerWith();
  await relayer.deposit(goodBody());
  assert.equal(calls.written[0].maxFeePerGas, 151_000_000_000n);
  assert.equal(calls.written[0].maxPriorityFeePerGas, 1_000_000_000n);
  // 250k gas x 151 gwei = 0.0377 MON needed; a balance of 0.02 MON passes the 0.1 MON floor check only if the floor is lower
  const poor = relayerWith({ balance: 3n * 10n ** 16n }, { minBalance: 10n ** 16n }).relayer;
  await assert.rejects(poor.deposit(goodBody()), (e) => e.status === 503);
});

test("deposit: rate limits the same owner (3 per minute)", async () => {
  const { relayer } = relayerWith();
  for (let i = 0; i < 3; i++) await relayer.deposit(goodBody());
  await assert.rejects(relayer.deposit(goodBody()), (e) => e.status === 429 && e.extra.retryAfterSeconds > 0);
  await relayer.deposit(goodBody({ owner: ADDR(0xb0b) })); // another owner is fine
});

test("deposit: a global cap protects the relayer from many different owners", async () => {
  const { relayer } = relayerWith({}, { globalPerMinute: 2 });
  await relayer.deposit(goodBody({ owner: ADDR(1) }));
  await relayer.deposit(goodBody({ owner: ADDR(2) }));
  await assert.rejects(relayer.deposit(goodBody({ owner: ADDR(3) })), (e) => e.status === 429);
});

function withdrawLog(assets) {
  const topics = encodeEventTopics({ abi: vaultAbi, eventName: "Withdraw", args: { sender: OWNER, receiver: OWNER, owner: OWNER } });
  const data = encodeAbiParameters(parseAbi(["function f(uint256 assets, uint256 shares)"])[0].inputs, [assets, 100000000000000n]);
  return { address: VAULT, topics, data, blockNumber: 1n, transactionHash: "0x" + "ab".repeat(32), transactionIndex: 0, blockHash: "0x" + "cd".repeat(32), logIndex: 0, removed: false };
}

function withdrawRelayer({ held = 10n ** 15n, isCity = true, estimateError = null, balance = 10n ** 18n } = {}) {
  const f = fakes({ isCity, balance, estimateError });
  f.publicClient.readContract = async ({ functionName }) => (functionName === "isCity" ? isCity : held);
  f.publicClient.waitForTransactionReceipt = async () => ({ status: "success", gasUsed: 300_000n, logs: [withdrawLog(100000000n)] });
  const relayer = createRelayer({ ...f, config: { factory: FACTORY, faucet: FAUCET }, now: () => 1_000_000_000_000 });
  return { relayer, ...f };
}

const goodWithdraw = (over = {}) => ({ vault: VAULT, owner: OWNER, shares: "100000000000000", deadline: "4102444800", v: 27, r: R, s: S, ...over });

test("withdraw: sends redeemWithPermit for the signer and reports who received the assets", async () => {
  const { relayer, calls } = withdrawRelayer();
  const out = await relayer.withdraw(goodWithdraw());
  assert.equal(out.status, "success");
  assert.equal(out.assets, "100000000");
  assert.equal(out.receiver.toLowerCase(), OWNER.toLowerCase(), "assets go to the owner, not the relayer");
  assert.equal(calls.written[0].functionName, "redeemWithPermit");
  assert.equal(calls.written[0].args[0], OWNER);
  assert.equal(calls.written[0].args[1], 100000000000000n);
});

test("withdraw: refuses more shares than the owner holds, foreign vaults and doomed transactions", async () => {
  await assert.rejects(withdrawRelayer({ held: 5n }).relayer.withdraw(goodWithdraw()), /only holds 5 shares/);
  await assert.rejects(withdrawRelayer({ isCity: false }).relayer.withdraw(goodWithdraw()), /factory/);
  const doomed = withdrawRelayer({ estimateError: "execution reverted: PermitNotHonoured" });
  await assert.rejects(doomed.relayer.withdraw(goodWithdraw()), (e) => e.status === 400 && /would fail/.test(e.message));
  assert.equal(doomed.calls.written.length, 0);
});

test("withdraw: rate limits per owner, independently from deposits", async () => {
  const { relayer } = withdrawRelayer();
  for (let i = 0; i < 3; i++) await relayer.withdraw(goodWithdraw());
  await assert.rejects(relayer.withdraw(goodWithdraw()), (e) => e.status === 429);
});

test("faucet: sends requestFunds for the recipient and rate limits repeat requests", async () => {
  const { relayer, calls } = relayerWith();
  const out = await relayer.faucet({ address: OWNER });
  assert.equal(out.status, "success");
  assert.equal(calls.written[0].functionName, "requestFunds");
  assert.equal(calls.written[0].args[0], OWNER);
  await assert.rejects(relayer.faucet({ address: OWNER }), (e) => e.status === 429);
});

test("faucet: turns the faucet's frequency limit into a retry hint", async () => {
  const { relayer, calls } = relayerWith({ simulateError: "execution reverted: MaxFrequencyExceeded" });
  await assert.rejects(relayer.faucet({ address: OWNER }), (e) => e.status === 429 && e.extra.retryAfterSeconds === 20);
  assert.equal(calls.written.length, 0);
});

test("faucet: recognises the frequency error even when viem only shows the raw selector", async () => {
  const f = fakes();
  f.publicClient.simulateContract = async () => {
    const e = new Error('The contract function "requestFunds" reverted with the following signature:');
    e.data = "0x20e5bc67";
    throw e;
  };
  const relayer = createRelayer({ ...f, config: { factory: FACTORY, faucet: FAUCET }, now: () => 1_000_000_000_000 });
  await assert.rejects(relayer.faucet({ address: OWNER }), (e) => e.status === 429 && e.extra.retryAfterSeconds === 20);
});

test("faucet: any other refusal is a 400 with the reason", async () => {
  const { relayer } = relayerWith({ simulateError: "execution reverted: SomethingElse" });
  await assert.rejects(relayer.faucet({ address: OWNER }), (e) => e.status === 400 && /SomethingElse/.test(e.message));
});

test("gas drip: sends a fixed amount of MON to a poor wallet, once per day per address", async () => {
  const { relayer, calls } = relayerWith();
  const out = await relayer.gasDrip({ address: OWNER });
  assert.equal(out.amountWei, "500000000000000000");
  assert.equal(calls.sent[0].to, OWNER);
  assert.equal(calls.sent[0].value, 500000000000000000n);
  assert.equal(calls.sent[0].gas, 21000n);
  await assert.rejects(relayer.gasDrip({ address: OWNER }), (e) => e.status === 429);
});

test("gas drip: refuses a wallet that already has enough MON, and the relayer itself", async () => {
  const rich = relayerWith({ recipientBalance: 10n ** 18n }).relayer;
  await assert.rejects(rich.gasDrip({ address: OWNER }), (e) => e.status === 400 && /no drip needed/.test(e.message));
  const { relayer } = relayerWith();
  await assert.rejects(relayer.gasDrip({ address: RELAYER }), (e) => e.status === 400);
});

test("gas drip: hourly cap across all addresses, and not when the relayer cannot afford it", async () => {
  const { relayer } = relayerWith({}, { gasDripsPerHour: 2 });
  await relayer.gasDrip({ address: ADDR(1) });
  await relayer.gasDrip({ address: ADDR(2) });
  await assert.rejects(relayer.gasDrip({ address: ADDR(3) }), (e) => e.status === 429);
  const poor = relayerWith({ balance: 3n * 10n ** 17n }).relayer;
  await assert.rejects(poor.gasDrip({ address: OWNER }), (e) => e.status === 503);
});

test("faucet: disabled when no faucet is configured", async () => {
  const { relayer } = relayerWith({}, { faucet: null });
  await assert.rejects(relayer.faucet({ address: OWNER }), (e) => e.status === 404);
});

test("health reports the relayer address and balance", async () => {
  const { relayer } = relayerWith();
  const h = await relayer.health();
  assert.equal(h.relayer, RELAYER);
  assert.equal(h.ok, true);
});
