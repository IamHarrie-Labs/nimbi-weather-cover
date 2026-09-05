/**
 * The decisive test: does the free-ask thesis hold?
 *
 * Three things this answers, none of which can be known from the docs:
 *   1. does wallet auth actually complete against the live socket
 *   2. does `ask` return a real miner answer
 *   3. how fast can we ask before the server throttles or drops us
 *
 * If (3) comes back at a handful per minute, the "agent runs continuously"
 * plan needs rethinking, and better to learn that now.
 */

import { readFileSync } from "node:fs";
import { Telegraph } from "./telegraph.js";
import { readTemperature } from "./consensus.js";

function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const QUESTION = "What is the current temperature in Cairo?";

async function main() {
  loadEnv();
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("AGENT_PRIVATE_KEY missing from .env");

  const tg = new Telegraph(key, { askTimeout: 60_000 });
  console.log(`agent ${tg.address}`);

  console.log("\n[1] authenticating...");
  const t0 = Date.now();
  await tg.connect();
  console.log(`    authenticated in ${Date.now() - t0}ms`);

  console.log("\n[2] one live ask");
  const a0 = Date.now();
  const res = await tg.ask(QUESTION);
  const ms = Date.now() - a0;
  console.log(`    ${ms}ms  miner=${res.miner_name ?? res.miner_id ?? "?"}  intent=${res.intent ?? "?"}`);
  console.log(`    cost_usd=${res.cost_usd ?? "-"}  signal_hash=${String(res.signal_hash ?? "-").slice(0, 26)}`);
  const t = readTemperature(res.result ?? res);
  console.log(`    parsed: ${t ? t.celsius.toFixed(2) + "°C via " + t.source : "UNREADABLE"}`);
  console.log(`    raw: ${JSON.stringify(res.result ?? res).slice(0, 220)}`);

  console.log("\n[3] rate probe — 8 sequential asks");
  const lat = [];
  const miners = new Map();
  let failed = 0;
  const burst0 = Date.now();
  for (let i = 0; i < 8; i++) {
    const s = Date.now();
    try {
      const r = await tg.ask(QUESTION);
      const d = Date.now() - s;
      lat.push(d);
      const who = r.miner_name ?? r.miner_id ?? "?";
      miners.set(who, (miners.get(who) || 0) + 1);
      const tp = readTemperature(r.result ?? r);
      console.log(`    ${String(i + 1).padStart(2)}  ${String(d).padStart(6)}ms  ${String(who).slice(0, 28).padEnd(30)} ${tp ? tp.celsius.toFixed(1) + "°C" : "unreadable"}`);
    } catch (e) {
      failed++;
      console.log(`    ${String(i + 1).padStart(2)}  FAILED  ${(e.message || "").slice(0, 70)}`);
    }
  }
  const total = Date.now() - burst0;

  console.log(`\n    ${lat.length} ok / ${failed} failed in ${(total / 1000).toFixed(1)}s`);
  if (lat.length) {
    const sorted = [...lat].sort((a, b) => a - b);
    console.log(`    latency  min ${sorted[0]}ms  median ${sorted[Math.floor(sorted.length / 2)]}ms  max ${sorted[sorted.length - 1]}ms`);
    console.log(`    throughput ~${(lat.length / (total / 1000) * 60).toFixed(1)} asks/min sequential`);
  }
  console.log(`    distinct miners seen: ${miners.size} -> ${[...miners.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`);

  tg.close();
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
});
