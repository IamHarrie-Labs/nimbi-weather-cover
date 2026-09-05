/**
 * Can we read the same question from several *specific* miners at once?
 *
 * Plain `ask` uses LLM routing and kept landing on the same miner (7304), so
 * repeated asking never produced the independent readings the consensus gate
 * needs. `ask_direct` names the miner — but the docs show it carrying a
 * method/endpoint/payload, which would mean knowing each miner's private
 * shape.
 *
 * This probes two things at once:
 *   - does ask_direct work with only { subnet_id, query }?
 *   - does one socket per miner give real parallelism?
 */

import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { Wallet } from "ethers";
import { readTemperature } from "./consensus.js";
import { WEATHER_MINERS, place } from "./miners.js";

const WS_URL = "wss://devnode.telegraphprotocol.com/engine/ws";
const PLACE = place(process.argv[2] || "cairo");
const MINERS = WEATHER_MINERS;

function key() {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  return env.match(/AGENT_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/)[1];
}

/** One authenticated socket, one ask_direct, then close. */
function askDirect(wallet, miner, timeoutMs = 75_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (o) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ miner, ms: Date.now() - started, ...o });
    };
    const timer = setTimeout(() => done({ error: "timeout" }), timeoutMs);

    const ws = new WebSocket(`${WS_URL}?wallet_address=${wallet.address}`);
    ws.on("error", (e) => done({ error: e.message.slice(0, 60) }));
    ws.on("open", () => ws.send(JSON.stringify({ action: "auth_wallet" })));

    ws.on("message", async (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      if (m.type === "wallet_challenge") {
        const sig = await wallet.signMessage(m.data.message);
        ws.send(JSON.stringify({ action: "wallet_verify", signature: sig }));
        return;
      }
      if (m.type === "wallet_verified" || m.type === "connected") {
        if (!ws._sent) {
          ws._sent = true;
          // Deliberately minimal: no method, endpoint or payload.
          ws.send(JSON.stringify({
            action: "ask_direct",
            subnet_id: miner.id,
            method: miner.method,
            endpoint: miner.endpoint,
            payload: miner.payload(PLACE),
            acknowledge_warnings: true,
          }));
        }
        return;
      }
      if (m.type === "error") return done({ error: String(m.data?.message ?? "").slice(0, 90) });
      if (m.type === "result" || m.type === "answer" || m.data?.result !== undefined) {
        const d = m.data ?? m;
        return done({ subnet_id: d.subnet_id, name: d.subnet_name, endpoint: d.endpoint, result: d.result ?? d });
      }
    });
  });
}

async function main() {
  const wallet = new Wallet(key());
  console.log(`agent ${wallet.address}`);
  console.log(`asking ${MINERS.length} miners in parallel, one socket each\n`);

  const sequential = process.argv.includes("--seq");
  const t0 = Date.now();
  let rows;
  if (sequential) {
    rows = [];
    for (const m of MINERS) rows.push(await askDirect(wallet, m, 45_000));
  } else {
    rows = await Promise.all(MINERS.map((m) => askDirect(wallet, m)));
  }
  const wall = Date.now() - t0;

  console.log(`${"miner".padEnd(26)}${"id".padEnd(11)}${"ms".padStart(7)}   reading`);
  console.log("-".repeat(78));
  const temps = [];
  for (const r of rows) {
    let reading;
    if (r.error) {
      reading = `ERROR ${r.error}`;
    } else {
      const t = readTemperature(r.result);
      if (t) { temps.push({ slug: r.miner.slug, c: t.celsius }); reading = `${t.celsius.toFixed(2)}°C  via ${t.source}`; }
      else reading = `unparsed: ${JSON.stringify(r.result).slice(0, 60)}`;
    }
    console.log(`${r.miner.slug.slice(0, 24).padEnd(26)}${r.miner.id.padEnd(11)}${String(r.ms).padStart(7)}   ${reading}`);
  }

  console.log(`\nwall clock ${(wall / 1000).toFixed(1)}s for ${MINERS.length} parallel asks`);
  console.log(`readable: ${temps.length}/${MINERS.length}`);

  if (temps.length >= 2) {
    const vals = temps.map((t) => t.c).sort((a, b) => a - b);
    const min = vals[0], max = vals[vals.length - 1];
    const median = vals[Math.floor(vals.length / 2)];
    const spreadPct = median !== 0 ? ((max - min) / Math.abs(median)) * 100 : 0;
    console.log(`\nmin ${min.toFixed(2)}  median ${median.toFixed(2)}  max ${max.toFixed(2)}`);
    console.log(`spread ${(max - min).toFixed(2)}°C  (${spreadPct.toFixed(1)}% of median)`);
    console.log(temps.map((t) => `${t.slug}=${t.c.toFixed(1)}`).join("  "));
  } else {
    console.log("\nNOT ENOUGH INDEPENDENT READINGS — consensus gate cannot work on this intent yet.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
