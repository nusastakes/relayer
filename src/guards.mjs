// Small building blocks for the relayer: errors, request validation, a rate limiter and a mutex.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^[0-9]{1,78}$/;

function address(value, name) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new HttpError(400, `${name} must be a 20-byte hex address`);
  return value;
}

function uint(value, name) {
  const s = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof s !== "string" || !UINT.test(s)) throw new HttpError(400, `${name} must be a non-negative integer (use a string for large numbers)`);
  return BigInt(s);
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new HttpError(400, `${name} must be 32 bytes of hex`);
  return value;
}

/** Validates the body of POST /deposit. Returns typed values; throws HttpError(400) otherwise. */
export function parseDepositBody(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
  let v = uint(body.v, "v");
  if (v === 0n || v === 1n) v += 27n; // some signers return the recovery id instead of 27/28
  if (v !== 27n && v !== 28n) throw new HttpError(400, "v must be 27 or 28");
  const assets = uint(body.assets, "assets");
  if (assets === 0n) throw new HttpError(400, "assets must be greater than zero");
  return {
    vault: address(body.vault, "vault"),
    owner: address(body.owner, "owner"),
    assets,
    deadline: uint(body.deadline, "deadline"),
    v: Number(v),
    r: bytes32(body.r, "r"),
    s: bytes32(body.s, "s"),
  };
}

export function parseFaucetBody(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
  return { address: address(body.address, "address") };
}

/** Fixed-window counter per key. `hit(key)` returns true if the call is allowed. */
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const buckets = new Map();
  return {
    hit(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.start >= windowMs) {
        buckets.set(key, { start: t, count: 1 });
        if (buckets.size > 10_000) for (const [k, v] of buckets) if (t - v.start >= windowMs) buckets.delete(k);
        return true;
      }
      if (b.count >= max) return false;
      b.count += 1;
      return true;
    },
    retryAfterMs(key) {
      const b = buckets.get(key);
      return b ? Math.max(0, windowMs - (now() - b.start)) : 0;
    },
  };
}

/** Runs async functions one at a time, so one sending account never reuses a nonce. */
export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
