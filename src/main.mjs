#!/usr/bin/env node
// Production entry point: the HTTP relayer, and optionally the APY keeper in the same process.
//
//   RELAYER_PRIVATE_KEY=0x… RUN_KEEPER=1 node src/main.mjs
//
// Environment: everything server.mjs reads, plus RUN_KEEPER=1 (also run the APY keeper), KEEPER_INTERVAL_SEC
// (default 3600), KEEPER_WINDOW_DAYS (default 3), RESOLVER=1 (settle CityServices prediction markets, every
// RESOLVER_INTERVAL_SEC, default 60) and RELEASER=1 (release streamed service fees into city vaults, checked every
// RELEASER_INTERVAL_SEC, default 300, at most every 30 minutes per city), RUN_TUNED (write each TunedMirrorAdapter's
// effective APY, every TUNED_INTERVAL_SEC, default 60; on by default with RUN_KEEPER=1, RUN_TUNED=0 turns it off) and
// RUN_AUTOPILOT=1 (carry out mayors' rules as their session key, every AUTOPILOT_INTERVAL_SEC, default 120; needs
// AUTOPILOT_PRIVATE_KEY). PORT is provided by the host (Railway).

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
    let delaySec = intervalSec;
    try {
      await step(options);
    } catch (e) {
      console.error(`keeper step failed: ${e.shortMessage || e.message}`);
      delaySec = Math.min(intervalSec, 90); // the public RPC drops requests now and then: try again soon, not in an hour
    }
    keeperTimer = setTimeout(tick, delaySec * 1000);
  };
  console.log(`keeper enabled, every ${intervalSec}s`);
  keeperTimer = setTimeout(tick, 8_000);
}

let indexerTimer;
if (process.env.RUN_INDEXER === "1" && relayer.indexer) {
  const tick = async () => {
    let delaySec = 20;
    try {
      const r = await relayer.indexer.step();
      if (r.behind > 0 || r.backfill > 0) delaySec = 1; // still catching up (or backfilling a contract added later): keep going
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
  analystTimer = setTimeout(tick, 25_000); // staggered: the indexer catches up first, then the keeper, analyst and watchdog
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
  watchdogTimer = setTimeout(tick, 45_000);
}

// The catalog downloads DefiLlama Yields (about 11 MB) on first use: warm it so the first GET /catalog is quick.
if (relayer.catalog) setTimeout(() => relayer.catalog.get().catch((e) => console.error(`catalog warm-up failed: ${e?.message || e}`)), 15_000);

let resolverTimer;
if (process.env.RESOLVER === "1" && relayer.serviceJobs) {
  const intervalSec = Number(process.env.RESOLVER_INTERVAL_SEC || 60);
  const tick = async () => {
    try {
      const done = await relayer.serviceJobs.resolveDue();
      if (done.length) console.log(`resolver: ${JSON.stringify(done)}`);
    } catch (e) {
      console.error(`resolver failed: ${e.shortMessage || e.message}`);
    }
    resolverTimer = setTimeout(tick, intervalSec * 1000);
  };
  console.log(`prediction-market resolver enabled, every ${intervalSec}s`);
  resolverTimer = setTimeout(tick, 35_000);
}

let releaserTimer;
if (process.env.RELEASER === "1" && relayer.serviceJobs) {
  const intervalSec = Number(process.env.RELEASER_INTERVAL_SEC || 300);
  const tick = async () => {
    try {
      const done = await relayer.serviceJobs.releaseDue();
      if (done.length) console.log(`releaser: ${JSON.stringify(done)}`);
    } catch (e) {
      console.error(`releaser failed: ${e.shortMessage || e.message}`);
    }
    releaserTimer = setTimeout(tick, intervalSec * 1000);
  };
  console.log(`service-fee releaser enabled, every ${intervalSec}s`);
  releaserTimer = setTimeout(tick, 55_000);
}

let tunedTimer;
if (relayer.tuned && (process.env.RUN_TUNED === "1" || (process.env.RUN_KEEPER === "1" && process.env.RUN_TUNED !== "0"))) {
  const intervalSec = Number(process.env.TUNED_INTERVAL_SEC || 60);
  const tick = async () => {
    try {
      const written = await relayer.tuned.round();
      if (written.length) console.log(`tuned keeper: ${JSON.stringify(written)}`);
    } catch (e) {
      console.error(`tuned keeper failed: ${e.shortMessage || e.message}`);
    }
    tunedTimer = setTimeout(tick, intervalSec * 1000);
  };
  console.log(`tuned keeper enabled, every ${intervalSec}s`);
  tunedTimer = setTimeout(tick, 20_000);
}

let autopilotTimer;
if (process.env.RUN_AUTOPILOT === "1" && relayer.autopilot?.address) {
  const intervalSec = Number(process.env.AUTOPILOT_INTERVAL_SEC || 120);
  const tick = async () => {
    try {
      const done = await relayer.autopilot.run();
      if (done.length) console.log(`autopilot: ${JSON.stringify(done)}`);
    } catch (e) {
      console.error(`autopilot failed: ${e.shortMessage || e.message}`);
    }
    autopilotTimer = setTimeout(tick, intervalSec * 1000);
  };
  console.log(`autopilot ${relayer.autopilot.address} enabled, every ${intervalSec}s`);
  autopilotTimer = setTimeout(tick, 65_000);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearTimeout(tunedTimer);
    clearTimeout(autopilotTimer);
    clearTimeout(resolverTimer);
    clearTimeout(releaserTimer);
    clearTimeout(keeperTimer);
    clearTimeout(analystTimer);
    clearTimeout(watchdogTimer);
    clearTimeout(indexerTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
