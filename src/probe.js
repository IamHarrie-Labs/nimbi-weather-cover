/**
 * Validates the consensus gate against real miner output shapes.
 *
 * Runs without a wallet or escrow: it fetches a live weather miner that is
 * openly reachable, then exercises the parser on the heterogeneous shapes the
 * network actually returns. The point is to prove the gate works before the
 * paid path is wired.
 */

import { readTemperature, agree, extractNumbers } from "./consensus.js";

const LIVE = "https://telegraph-sky.margyn.workers.dev/weather?location=";

async function live(location) {
  const r = await fetch(LIVE + encodeURIComponent(location));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Shapes observed across real Telegraph weather miners. */
const SHAPES = [
  { name: "keyed float", payload: { temperature_c: 23.4, humidity: 71 } },
  { name: "keyed, no suffix", payload: { temperature: 23.6, unit: "C" } },
  { name: "prose celsius", payload: "It is currently 23.5°C and raining in London." },
  { name: "prose fahrenheit", payload: "Currently 74.3 °F with light showers." },
  { name: "kelvin", payload: { temp: 296.7, unit: "K" } },
  { name: "unicode minus", payload: "Temperature is −4.5°C with snow." },
  { name: "eu decimal", payload: "Aktuell 23,4 °C und Regen." },
  { name: "noise around it", payload: { lat: 51.5072, lon: -0.1275, temperature_c: 23.3 } },
];

function bar(label, ok) {
  return `${ok ? "OK  " : "FAIL"}  ${label}`;
}

async function main() {
  console.log("=== parser against real miner shapes\n");
  let bad = 0;
  for (const { name, payload } of SHAPES) {
    const t = readTemperature(payload);
    // Every fixture above describes roughly the same warm-London reading
    // except the deliberate sub-zero one.
    const expected = name === "unicode minus" ? -4.5 : 23.4;
    const ok = t && Math.abs(t.celsius - expected) < 0.6;
    if (!ok) bad++;
    console.log(
      `  ${bar(name.padEnd(20), ok)} -> ${t ? t.celsius.toFixed(2) + "°C via " + t.source : "no reading"}`,
    );
  }

  console.log("\n=== live miner (openly reachable, no payment)\n");
  try {
    const body = await live("London");
    const t = readTemperature(body);
    console.log(`  skywire London        -> ${t ? t.celsius.toFixed(2) + "°C" : "unreadable"}`);
    console.log(`  raw temperature_c     -> ${body.temperature_c}`);
  } catch (e) {
    console.log(`  live fetch failed: ${e.message}`);
  }

  console.log("\n=== gate decisions\n");
  const cases = [
    {
      label: "miners agree",
      readings: [
        { minerId: "a", celsius: 23.4 },
        { minerId: "b", celsius: 23.6 },
        { minerId: "c", celsius: 23.5 },
      ],
    },
    {
      label: "one outlier",
      readings: [
        { minerId: "a", celsius: 23.4 },
        { minerId: "b", celsius: 23.6 },
        { minerId: "c", celsius: 31.2 },
      ],
    },
    {
      label: "single source",
      readings: [{ minerId: "a", celsius: 23.4 }],
    },
  ];
  for (const c of cases) {
    const v = agree(c.readings, 1.5);
    console.log(
      `  ${c.label.padEnd(16)} ${v.ok ? "PAY   " : "HOLD  "} ` +
        `median=${v.value ?? "-"} spread=${v.spread ?? "-"} ` +
        (v.reason ? `| ${v.reason}` : ""),
    );
  }

  console.log(`\nparser failures: ${bad}/${SHAPES.length}`);
  process.exitCode = bad === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
