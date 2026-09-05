/**
 * Talking to Telegraph miners.
 *
 * Two constraints shape everything here:
 *
 *   1. `ask_direct` needs the subnet id, method and endpoint spelled out — the
 *      engine will not infer them. Plain `ask` does infer, but it kept routing
 *      to the same miner, which defeats the point of a consensus read.
 *   2. The engine allows one outstanding request per wallet. Six asks fired in
 *      parallel returned one answer and five errors; the same six run
 *      sequentially return six. So `readMiners` is a serial loop, and that is
 *      deliberate, not an oversight.
 */

import { WebSocket } from "ws";
import { readTemperature } from "./consensus.js";
import { WEATHER_MINERS } from "./miners.js";

const WS_URL = "wss://devnode.telegraphprotocol.com/engine/ws";

/** One authenticated socket, one ask_direct, one answer. Never throws. */
export function askDirect(wallet, miner, place, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    const done = (o) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ miner, ...o });
    };
    const timer = setTimeout(() => done({ error: "timeout" }), timeoutMs);
    const ws = new WebSocket(`${WS_URL}?wallet_address=${wallet.address}`);
    ws.on("error", (e) => done({ error: e.message.slice(0, 50) }));
    ws.on("open", () => ws.send(JSON.stringify({ action: "auth_wallet" })));
    ws.on("message", async (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "wallet_challenge") {
        ws.send(JSON.stringify({ action: "wallet_verify", signature: await wallet.signMessage(m.data.message) }));
        return;
      }
      if ((m.type === "wallet_verified" || m.type === "connected") && !ws._sent) {
        ws._sent = true;
        ws.send(JSON.stringify({
          action: "ask_direct",
          subnet_id: miner.id,
          method: miner.method,
          endpoint: miner.endpoint,
          payload: miner.payload(place),
          acknowledge_warnings: true,
        }));
        return;
      }
      if (m.type === "error") return done({ error: String(m.data?.message ?? "").slice(0, 70) });
      if (m.data?.result !== undefined) return done({ result: m.data.result });
    });
  });
}

/**
 * Ask every weather miner about one place.
 *
 * Miners that error or answer unreadably are dropped rather than guessed at —
 * a settlement should rest on what was actually said. `onRead` reports each
 * one as it lands so a long serial read shows progress.
 */
export async function readMiners(wallet, place, onRead = () => {}) {
  const readings = [];
  for (const miner of WEATHER_MINERS) {
    const r = await askDirect(wallet, miner, place);
    if (r.error) {
      onRead({ slug: miner.slug, error: r.error });
      continue;
    }
    const t = readTemperature(r.result);
    if (!t) {
      onRead({ slug: miner.slug, error: "unreadable" });
      continue;
    }
    const reading = { slug: miner.slug, subnetId: miner.id, celsius: t.celsius, source: t.source };
    readings.push(reading);
    onRead(reading);
  }
  return readings;
}
