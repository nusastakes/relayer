// Quarantine watchdog (contracts v3, finding F-02).
//
// In v3 anyone can call `CityVault.quarantine(adapter)` while an adapter's `totalAssets()` really fails, which takes the
// adapter out of the city's books so the rest of the city keeps working, and anyone can call `restoreAdapter(adapter)` once it
// works again. Nothing presses those buttons by itself, so a city stays frozen until somebody notices. This bot does:
//  * every few minutes it looks at every adapter of every city and probes `totalAssets()` the way the vault does (a static call
//    with the same 3,000,000 gas cap);
//  * a healthy-looking city is left alone; an adapter that fails and is not quarantined gets `quarantine`; a quarantined
//    adapter that works again gets `restoreAdapter`;
//  * before sending it asks the node whether the transaction would succeed, so it never pays for a call the vault would
//    refuse (the vault runs its own probe and is the judge).
// It only ever calls those two permissionless functions; it cannot move money. Limits keep a flapping adapter or a bad RPC
// from draining the relayer's gas: a cooldown per adapter, a cap on actions per hour, and a minimum balance.

import { getAddress, parseAbi } from "viem";

/** A dropped or rate-limited request says nothing about the adapter, so it must never count as the adapter failing. */
export function isTransportError(e) {
  const m = String(e?.shortMessage || e?.message || e);
  return /RPC Request failed|HTTP request failed|fetch failed|timeout|timed out|ECONN|socket hang up|rate limit|429|502|503|504/i.test(m) && !/revert|out of gas/i.test(m);
}

/** The public testnet RPC drops requests under load; try a few times before giving up on a read. */
async function retry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !isTransportError(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
    }
  }
}

/** The vault's probe gas cap (CityVault.PROBE_GAS); the transaction itself must carry a bit more than that. */
export const PROBE_GAS = 3_000_000n;
/** Most gas a watchdog transaction may carry: the probe alone can use 3M when an adapter burns all it is given. */
const MAX_TX_GAS = 4_200_000n;
const TOTAL_ASSETS_SELECTOR = "0x01e1d114"; // totalAssets()

const factoryAbi = parseAbi(["function cityCount() view returns (uint256)", "function cityAt(uint256) view returns (address)"]);
const vaultAbi = parseAbi([
  "function adapters() view returns (address[])",
  "function quarantined(address) view returns (bool)",
  "function quarantine(address adapter)",
  "function restoreAdapter(address adapter)",
]);

/**
 * @param {{publicClient: any, factory: string, send: (request: object) => Promise<{hash: string}>, now?: () => number,
 *   config?: {cooldownSeconds?: number, maxActionsPerHour?: number, minBalanceWei?: bigint, maxCities?: number}, balance?: () => Promise<bigint>}} options
 * `send` is the relayer's own sender, which keeps nonces in order and counts gas against its budget.
 */
export function createWatchdog({ publicClient, factory, send, balance = null, now = () => Date.now(), config = {} }) {
  const c = { cooldownSeconds: 600, maxActionsPerHour: 6, minBalanceWei: 2n * 10n ** 18n, maxCities: 200, ...config };
  const lastAction = new Map();
  const actionTimes = [];
  let running = false;
  const status = { lastScanAt: null, scanned: 0, adapters: 0, quarantined: 0, actions: [], errors: 0, lastError: null };
  const noteError = (e) => {
    status.errors += 1;
    status.lastError = String(e?.shortMessage || e?.message || e).slice(0, 160);
  };

  const seconds = () => Math.floor(now() / 1000);

  /** Same question the vault asks: does `totalAssets()` return one word within the gas cap? */
  async function probe(adapter) {
    try {
      const result = await retry(() => publicClient.call({ to: adapter, data: TOTAL_ASSETS_SELECTOR, gas: PROBE_GAS }));
      return typeof result?.data === "string" && result.data.length === 66; // 0x + 32 bytes
    } catch (e) {
      if (isTransportError(e)) throw e; // unknown, not "failing": the caller counts it as an error and does nothing
      return false;
    }
  }

  function budgetAllows(key) {
    const t = seconds();
    while (actionTimes.length && actionTimes[0] < t - 3600) actionTimes.shift();
    if (actionTimes.length >= c.maxActionsPerHour) return "hourly-limit";
    if ((lastAction.get(key) ?? 0) > t - c.cooldownSeconds) return "cooldown";
    return null;
  }

  async function act(city, adapter, functionName) {
    // One cooldown per adapter and per kind of action, so a restore right after a quarantine is not held back by it.
    const key = `${city}:${adapter}:${functionName}`.toLowerCase();
    const blocked = budgetAllows(key);
    if (blocked) return { city, adapter, action: functionName, result: blocked };
    if (balance) {
      const have = await balance();
      if (have < c.minBalanceWei) return { city, adapter, action: functionName, result: "low-balance" };
    }
    lastAction.set(key, seconds());
    actionTimes.push(seconds());
    try {
      // `send` asks the node first and refuses a transaction that would fail, so a disagreement with the vault's own probe costs nothing.
      const { hash } = await send({ address: city, abi: vaultAbi, functionName, args: [adapter] }, { maxGas: MAX_TX_GAS });
      return { city, adapter, action: functionName, result: "sent", hash };
    } catch (e) {
      return { city, adapter, action: functionName, result: "refused", reason: String(e?.shortMessage || e?.message || e).slice(0, 160) };
    }
  }

  /** One pass over every city. Never throws; returns what it did. */
  async function scan() {
    if (running) return { skipped: "already running" };
    running = true;
    const actions = [];
    let cities = 0;
    let adaptersSeen = 0;
    let quarantinedSeen = 0;
    try {
      const count = Number(await retry(() => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "cityCount" })));
      for (let i = 0; i < Math.min(count, c.maxCities); i++) {
        let city;
        let adapters;
        try {
          city = getAddress(await retry(() => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "cityAt", args: [BigInt(i)] })));
          adapters = await retry(() => publicClient.readContract({ address: city, abi: vaultAbi, functionName: "adapters" }));
        } catch (e) {
          noteError(e);
          continue;
        }
        cities += 1;
        for (const adapter of adapters) {
          adaptersSeen += 1;
          try {
            const isQuarantined = await retry(() => publicClient.readContract({ address: city, abi: vaultAbi, functionName: "quarantined", args: [adapter] }));
            if (isQuarantined) quarantinedSeen += 1;
            const works = await probe(adapter);
            if (!isQuarantined && !works) actions.push(await act(city, adapter, "quarantine"));
            else if (isQuarantined && works) actions.push(await act(city, adapter, "restoreAdapter"));
          } catch (e) {
            noteError(e);
          }
        }
      }
    } catch (e) {
      noteError(e);
    } finally {
      running = false;
    }
    status.lastScanAt = seconds();
    status.scanned = cities;
    status.adapters = adaptersSeen;
    status.quarantined = quarantinedSeen;
    if (actions.length) status.actions = [...actions, ...status.actions].slice(0, 20);
    return { cities, adapters: adaptersSeen, quarantined: quarantinedSeen, actions };
  }

  return {
    enabled: true,
    scan,
    probe,
    info: () => ({ ...status, config: { cooldownSeconds: c.cooldownSeconds, maxActionsPerHour: c.maxActionsPerHour, minBalanceWei: c.minBalanceWei.toString() } }),
  };
}
