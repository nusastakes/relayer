// Pure helpers for the APY keeper. No network access here, so they are easy to test.

export const YEAR_SECONDS = 365n * 24n * 3600n;
/** Same ceiling as ApyFeed.MAX_APY_BPS (50% a year). */
export const MAX_APY_BPS = 5000n;

/**
 * Annualised simple APY in basis points from two readings of the same share price taken `dtSeconds` apart.
 * Rounds half up, never negative (a falling price is reported as 0, the feed has no negative rates), and is clamped
 * to the feed's ceiling.
 */
export function computeApyBps(price0, price1, dtSeconds) {
  if (price0 <= 0n) throw new Error("price0 must be positive");
  if (dtSeconds <= 0n) throw new Error("dtSeconds must be positive");
  if (price1 <= price0) return 0n;
  const numerator = (price1 - price0) * YEAR_SECONDS * 10_000n;
  const denominator = price0 * dtSeconds;
  const bps = (2n * numerator + denominator) / (2n * denominator);
  return bps > MAX_APY_BPS ? MAX_APY_BPS : bps;
}

/** Converts Morpho's `netApy` (a fraction such as 0.015) to basis points, same clamping as above. */
export function apyFractionToBps(fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0n;
  const bps = BigInt(Math.round(fraction * 10_000));
  return bps > MAX_APY_BPS ? MAX_APY_BPS : bps;
}

/**
 * Largest block number whose timestamp is <= targetTs, by binary search.
 * `getTimestamp(n)` must return the timestamp (bigint seconds) of block n; `latest` is the newest block number.
 */
export async function findBlockAtOrBefore(getTimestamp, latest, targetTs, earliest = 1n) {
  if ((await getTimestamp(earliest)) > targetTs) throw new Error("target time is before the earliest block searched");
  let lo = earliest; // timestamp(lo) <= targetTs
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await getTimestamp(mid)) <= targetTs) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Whether a new reading is worth a transaction. */
export function shouldWrite({ newBps, currentBps, ageSeconds, minChangeBps, maxAgeSeconds }) {
  const diff = newBps > currentBps ? newBps - currentBps : currentBps - newBps;
  return diff >= minChangeBps || ageSeconds >= maxAgeSeconds;
}
