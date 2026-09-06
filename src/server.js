/**
 * Nimbi's backend.
 *
 * Three jobs, and the reason all three live behind one server instead of the
 * browser doing them directly:
 *
 *   - GET  /api/consensus?place=cairo   live miner read + verdict, for the
 *                                       landing page panel. Read-only, but
 *                                       still needs the agent wallet to
 *                                       authenticate `ask_direct` over the
 *                                       Telegraph websocket — a browser
 *                                       visitor has no such wallet and
 *                                       shouldn't need one just to look.
 *   - GET  /api/ledger                  every policy + its attestations, for
 *                                       both pages' settlement lists.
 *   - POST /api/settle {id}             re-reads the miners fresh and calls
 *                                       reportReading. Only the agent wallet
 *                                       is allowed to call that on-chain, so
 *                                       this is the one place its private
 *                                       key may ever be loaded.
 *
 * Nothing here ever sends AGENT_PRIVATE_KEY to a client. A visitor's own
 * wallet handles buyPolicy, approve, and mint directly against the chain.
 */

import express from "express";
import cors from "cors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Contract, decodeBytes32String } from "ethers";
import { agentWallet, retry, send } from "./rpc.js";
import { agree } from "./consensus.js";
import { readMiners } from "./ask.js";
import { PLACES } from "./miners.js";

const PORT = process.env.PORT || 8787;

const deployment = JSON.parse(readFileSync(new URL("../build/deployment.json", import.meta.url), "utf8"));
const artifact = JSON.parse(readFileSync(new URL("../build/WeatherGuard.json", import.meta.url), "utf8"));

const wallet = agentWallet();
const guard = new Contract(deployment.address, artifact.abi, wallet);

const STATUS = ["Open", "PaidOut", "Expired", "Refunded"];

const app = express();
app.use(cors());
app.use(express.json());

// A verdict is only useful once, and every hit means an outstanding
// ask_direct per miner — the engine allows one at a time per wallet, so a
// second visitor mid-read would queue behind the first for a while. Cache
// each place's reading for a minute; the landing panel polls, it doesn't
// need a fresh websocket round-trip on every request.
const consensusCache = new Map(); // place -> { at, body }
const CACHE_MS = 60_000;

// The Telegraph engine allows one outstanding request per wallet, full stop —
// not per websocket connection. An HTTP request and the warm loop, or two
// HTTP requests, sharing the agent wallet at the same time will collide and
// one of them stalls or errors. So the whole cache-check-then-read-then-fill
// sequence below runs as one atomic queued unit: a caller that has to wait
// its turn re-checks the cache once it gets there, and if whoever went ahead
// of it already filled it, skips its own read entirely.
let queue = Promise.resolve();
function enqueue(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {}); // one failure must not wedge the queue
  return result;
}

async function readPlace(placeKey) {
  const place = PLACES[placeKey];
  if (!place) return null;

  const cached = () => {
    const c = consensusCache.get(placeKey);
    return c && Date.now() - c.at < CACHE_MS ? c.body : null;
  };
  if (cached()) return cached();

  return enqueue(async () => {
    const hit = cached();
    if (hit) return hit;
    return buildConsensusBody(placeKey, place, await readMiners(wallet, place));
  });
}

async function buildConsensusBody(placeKey, place, readings) {
  const toleranceMilliC = await retry("tolerance", () => guard.toleranceMilliC());
  const toleranceC = Number(toleranceMilliC) / 1000;
  const verdict = agree(readings, toleranceC);

  const body = {
    place: place.name,
    toleranceC,
    readings: readings.map((r) => ({ slug: r.slug, celsius: r.celsius })),
    // Miners that answered but were unreadable/erroring aren't in `readings`
    // at all — surface them too, so the panel can show all six rows rather
    // than a shrinking list.
    verdict: {
      ok: verdict.ok,
      value: verdict.value ?? null,
      spread: verdict.spread ?? null,
      totalSpread: verdict.totalSpread ?? null,
      agreeing: verdict.agreeing ?? 0,
      total: verdict.total ?? 0,
      reason: verdict.reason,
      outliers: (verdict.outliers ?? []).map((o) => ({ slug: o.slug, celsius: o.celsius, deviation: o.deviation })),
    },
    takenAt: new Date().toISOString(),
  };

  consensusCache.set(placeKey, { at: Date.now(), body });
  return body;
}

app.get("/api/places", (_req, res) => {
  res.json(Object.entries(PLACES).map(([key, p]) => ({ key, name: p.name })));
});

app.get("/api/consensus", async (req, res) => {
  const key = String(req.query.place || "cairo").toLowerCase();
  try {
    const body = await readPlace(key);
    if (!body) return res.status(404).json({ error: `unknown place: ${key}` });
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: e.shortMessage || e.message });
  }
});

app.get("/api/ledger", async (_req, res) => {
  try {
    const count = Number(await retry("policyCount", () => guard.policyCount()));
    const policies = [];
    for (let i = 0; i < count; i++) {
      const p = await retry(`policy:${i}`, () => guard.policies(i));
      const attCount = Number(await retry(`attCount:${i}`, () => guard.attestationCount(i)));
      let last = null;
      if (attCount > 0) {
        const a = await retry(`att:${i}`, () => guard.attestationAt(i, attCount - 1));
        last = {
          settled: a.settled,
          medianMilliC: Number(a.medianMilliC),
          spreadMilliC: Number(a.spreadMilliC),
          minersAgreeing: Number(a.minersAgreeing),
          minersTotal: Number(a.minersTotal),
        };
      }
      policies.push({
        id: i,
        holder: p.holder,
        place: decodeBytes32String(p.place),
        thresholdMilliC: Number(p.thresholdMilliC),
        payAbove: p.payAbove,
        premium: p.premium.toString(),
        payout: p.payout.toString(),
        expiry: Number(p.expiry),
        status: STATUS[Number(p.status)],
        attestations: attCount,
        last,
      });
    }
    res.json({ address: deployment.address, token: deployment.token, policies });
  } catch (e) {
    res.status(502).json({ error: e.shortMessage || e.message });
  }
});

app.post("/api/settle", async (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "id required" });

  try {
    const p = await retry(`policy:${id}`, () => guard.policies(id));
    if (STATUS[Number(p.status)] !== "Open") {
      return res.status(409).json({ error: `policy #${id} is already ${STATUS[Number(p.status)]}` });
    }

    const placeKey = decodeBytes32String(p.place).toLowerCase();
    const place = PLACES[placeKey];
    if (!place) return res.status(500).json({ error: `policy references unknown place: ${placeKey}` });

    // A settlement should act on the freshest read available, not the cache
    // the landing panel is showing — bypass it here even if it's still warm.
    // Still goes through the shared queue: settling and the landing panel's
    // reads use the same agent wallet and can't run concurrently either way.
    const readings = await enqueue(() => readMiners(wallet, place));
    if (readings.length < 3) {
      return res.status(422).json({ error: `only ${readings.length} readable miners — need at least 3` });
    }

    const toleranceMilliC = await retry("tolerance", () => guard.toleranceMilliC());
    const verdict = agree(readings, Number(toleranceMilliC) / 1000);

    const receipt = await send("reportReading", () =>
      guard.reportReading(
        id,
        Math.round((verdict.value ?? 0) * 1000),
        Math.max(0, Math.round((verdict.spread ?? 0) * 1000)),
        verdict.agreeing ?? 0,
        verdict.total ?? 0,
      ),
    );

    const names = { PaidOut: "PaidOut", SettlementHeld: "SettlementHeld", Checked: "Checked" };
    let outcome = null;
    for (const log of receipt.logs) {
      let parsed;
      try { parsed = guard.interface.parseLog(log); } catch { continue; }
      if (parsed && names[parsed.name]) {
        outcome = { event: parsed.name, args: JSON.parse(JSON.stringify(parsed.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) };
        break;
      }
    }

    consensusCache.delete(placeKey);
    res.json({ id, txHash: receipt.hash, outcome, verdict: { value: verdict.value, spread: verdict.spread, agreeing: verdict.agreeing, total: verdict.total, reason: verdict.reason } });
  } catch (e) {
    res.status(502).json({ error: e.shortMessage || e.message });
  }
});

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

// Clean URLs for the two secondary pages — /buy and /docs rather than
// /buy.html and /docs.html. The .html files stay put and still work
// directly (express.static below still serves them), so nothing already
// pointing at the old paths breaks; these just take priority.
app.get("/buy", (_req, res) => res.sendFile("buy.html", { root: publicDir }));
app.get("/docs", (_req, res) => res.sendFile("docs.html", { root: publicDir }));

app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`Nimbi backend on http://localhost:${PORT}`);
  console.log(`  contract ${deployment.address}`);
  console.log(`  agent    ${wallet.address}`);
});

// Warm every place's cache on boot, then keep looping. A full pass over five
// places takes longer than one place's cache lifetime, so this is a
// self-pacing loop rather than setInterval: readPlace already skips a place
// whose cache is still fresh, and a fixed-interval timer here would overlap
// two live reads on the same wallet — the exact "one outstanding request per
// wallet" failure the reader was built to avoid.
async function warmLoop() {
  for (const key of Object.keys(PLACES)) {
    try {
      await readPlace(key);
    } catch (e) {
      console.log(`  warm ${key} failed: ${e.shortMessage || e.message}`);
    }
  }
  setTimeout(warmLoop, 2_000);
}
warmLoop();
