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

/** Validates a permit-carrying body whose amount lives in `amountField`. Returns typed values with the amount under `amount`. */
function parsePermitBody(body, amountField) {
  if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
  let v = uint(body.v, "v");
  if (v === 0n || v === 1n) v += 27n; // some signers return the recovery id instead of 27/28
  if (v !== 27n && v !== 28n) throw new HttpError(400, "v must be 27 or 28");
  const amount = uint(body[amountField], amountField);
  if (amount === 0n) throw new HttpError(400, `${amountField} must be greater than zero`);
  return {
    vault: address(body.vault, "vault"),
    owner: address(body.owner, "owner"),
    amount,
    deadline: uint(body.deadline, "deadline"),
    v: Number(v),
    r: bytes32(body.r, "r"),
    s: bytes32(body.s, "s"),
  };
}

/** Validates the body of POST /deposit. Returns typed values; throws HttpError(400) otherwise. */
export function parseDepositBody(body) {
  const { amount, ...fields } = parsePermitBody(body, "assets");
  return { ...fields, assets: amount };
}

/** Validates the body of POST /withdraw: the same shape as a deposit, but the amount is `shares`. */
export function parseWithdrawBody(body) {
  const { amount, ...fields } = parsePermitBody(body, "shares");
  return { ...fields, shares: amount };
}

export function parseFaucetBody(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
  return { address: address(body.address, "address") };
}

/** Fixed-window counter per key. `hit(key)` returns true if the call is allowed. */
export function createRateLimiter({ windowMs, max, now = () => Date.now(), maxKeys = 50_000 }) {
  const buckets = new Map();
  let lastSweep = 0;
  /** Drops expired buckets, at most once a second so a flood of new keys cannot make every call O(n). */
  const sweep = (t) => {
    if (t - lastSweep < 1000) return;
    lastSweep = t;
    for (const [k, v] of buckets) if (t - v.start >= windowMs) buckets.delete(k);
  };
  return {
    size: () => buckets.size,
    hit(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.start >= windowMs) {
        if (!b && buckets.size >= maxKeys) {
          sweep(t);
          // Still full of live keys: refuse new ones instead of growing without bound (an attacker rotating keys).
          if (buckets.size >= maxKeys) return false;
        }
        buckets.set(key, { start: t, count: 1 });
        return true;
      }
      if (b.count >= max) return false;
      b.count += 1;
      return true;
    },
    /** Gives back one use, for requests that failed before costing anything. */
    refund(key) {
      const b = buckets.get(key);
      if (b && b.count > 0) b.count -= 1;
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
  #depth = 0;
  /** How many tasks are running or waiting. */
  get depth() {
    return this.#depth;
  }
  run(fn) {
    this.#depth += 1;
    const result = this.#tail.then(fn, fn);
    result.then(
      () => (this.#depth -= 1),
      () => (this.#depth -= 1),
    );
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Memoises an async call for `ttlMs` and shares one in-flight call between concurrent callers, so a public GET that
 * fans out to the RPC costs at most one round of reads per window however many clients ask. Errors are not cached.
 */
export function createMemo({ now = () => Date.now(), maxKeys = 500 } = {}) {
  const entries = new Map();
  return function memo(key, ttlMs, fn) {
    const hit = entries.get(key);
    if (hit && (hit.pending || now() - hit.at < ttlMs)) return hit.pending ?? Promise.resolve(hit.value);
    if (entries.size >= maxKeys) entries.clear();
    const pending = Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          entries.set(key, { at: now(), value, pending: null });
          return value;
        },
        (error) => {
          entries.delete(key);
          throw error;
        },
      );
    entries.set(key, { at: now(), value: undefined, pending });
    return pending;
  };
}
