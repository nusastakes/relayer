#!/usr/bin/env node
// Production entry point: the HTTP relayer, and optionally the APY keeper in the same process.
//
//   RELAYER_PRIVATE_KEY=0x… RUN_KEEPER=1 node src/main.mjs
//
// Environment: everything server.mjs reads, plus RUN_KEEPER=1 (also run the APY keeper), KEEPER_INTERVAL_SEC
// (default 3600), KEEPER_WINDOW_DAYS (default 3). PORT is provided by the host (Railway).

import { buildRelayerFromEnv, createHttpServer, parseAllowedOrigins } from "./server.mjs";
import { parseArgs, step } from "./keeper.mjs";

const relayer = buildRelayerFromEnv();
const port = Number(process.env.PORT || 8787);
const server = createHttpServer(relayer, {
  allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGIN),
  trustProxy: process.env.TRUST_PROXY === "1",
  trustedHops: Number(process.env.TRUST_PROXY_HOPS || 1),
  exposeIpDebug: process.env.EXPOSE_IP_DEBUG === "1",
});
server.listen(port, "0.0.0.0", () => console.log(`relayer listening on :${port} (factory ${relayer.config.factory})`));

let keeperTimer;
if (process.env.RUN_KEEPER === "1") {
  const intervalSec = Number(process.env.KEEPER_INTERVAL_SEC || 3600);
  const options = parseArgs(["--window-days", String(process.env.KEEPER_WINDOW_DAYS || 3)]);
  const tick = async () => {
    try {
      await step(options);
    } catch (e) {
      console.error(`keeper step failed: ${e.shortMessage || e.message}`);
    }
    keeperTimer = setTimeout(tick, intervalSec * 1000);
  };
  console.log(`keeper enabled, every ${intervalSec}s`);
  tick();
}

let indexerTimer;
if (process.env.RUN_INDEXER === "1" && relayer.indexer) {
  const tick = async () => {
    let delaySec = 20;
    try {
      const r = await relayer.indexer.step();
      if (r.behind > 0) delaySec = 1; // still catching up: keep going
      if (r.requests > 1) console.log(`indexer at block ${r.nextBlock} of ${r.head} (${r.behind} behind)`);
    } catch (e) {
      console.error(`indexer step failed: ${e.shortMessage || e.message}`);
      delaySec = 30;
    }
    indexerTimer = setTimeout(tick, delaySec * 1000);
  };
  console.log(`indexer enabled from block ${relayer.indexer.config.startBlock}`);
  tick();
}

let analystTimer;
if (process.env.RUN_ANALYST === "1" && relayer.analyst) {
  const intervalSec = Number(process.env.ANALYST_INTERVAL_SEC || 600);
  const tick = async () => {
    try {
      const results = await relayer.analyst.scanAll();
      const acted = results.filter((r) => r.status === "proposed" || r.status === "failed" || r.status === "error");
      console.log(`analyst scanned ${results.length} cities, ${results.filter((r) => r.status !== "not-granted").length} with the role${acted.length ? `: ${JSON.stringify(acted)}` : ""}`);
    } catch (e) {
      console.error(`analyst scan failed: ${e.shortMessage || e.message}`);
    }
    analystTimer = setTimeout(tick, intervalSec * 1000);
  };
  console.log(`analyst ${relayer.analyst.address} enabled, every ${intervalSec}s`);
  tick();
}

let watchdogTimer;
if (process.env.RUN_WATCHDOG === "1" && relayer.watchdog) {
  const intervalSec = Number(process.env.WATCHDOG_INTERVAL_SEC || 300);
  const tick = async () => {
    try {
      const r = await relayer.watchdog.scan();
      if (r.actions?.length) console.log(`watchdog: ${JSON.stringify(r.actions)}`);
    } catch (e) {
      console.error(`watchdog scan failed: ${e.shortMessage || e.message}`);
    }
    watchdogTimer = setTimeout(tick, intervalSec * 1000);
  };
  console.log(`watchdog enabled, every ${intervalSec}s`);
  tick();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearTimeout(keeperTimer);
    clearTimeout(analystTimer);
    clearTimeout(watchdogTimer);
    clearTimeout(indexerTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
