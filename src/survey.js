/**
 * Ask every weather miner about every place we price, and print how far apart
 * they land.
 *
 *   node src/survey.js
 *   node src/survey.js cairo london
 *
 * Read-only: no transactions, no gas. This exists to answer one question
 * honestly — is miner disagreement a real, place-dependent property, or an
 * artefact of one city? The demo's claim rests on the answer, so the answer
 * should be measured rather than assumed.
 */

import { writeFileSync } from "node:fs";
import { agentWallet } from "./rpc.js";
import { agree } from "./consensus.js";
import { readMiners } from "./ask.js";
import { PLACES } from "./miners.js";

const DEFAULT_TOLERANCE = 2.0; // the contract's shipped default, in Celsius

async function main() {
  const wallet = agentWallet();
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PLACES);
  const survey = [];

  for (const name of names) {
    const place = PLACES[name.toLowerCase()];
    if (!place) {
      console.log(`${name}: not a place we price`);
      continue;
    }

    console.log(`\n${place.name}`);
    const readings = await readMiners(wallet, place, (r) => {
      if (r.error) console.log(`    ${r.slug.padEnd(26)} ${r.error}`);
      else console.log(`    ${r.slug.padEnd(26)} ${r.celsius.toFixed(2)}C  via ${r.source}`);
    });

    if (readings.length < 3) {
      console.log(`  only ${readings.length} readable — not enough to settle on`);
      continue;
    }

    const verdict = agree(readings, DEFAULT_TOLERANCE);
    console.log(
      `  median ${verdict.value}C   spread ${verdict.spread}C   ` +
        `${verdict.agreeing}/${verdict.total} within ${DEFAULT_TOLERANCE}C   ` +
        `-> ${verdict.ok ? "AGREEMENT (would settle)" : "DISAGREEMENT (would hold)"}`,
    );
    if (verdict.outliers?.length) {
      console.log(`  outliers: ${verdict.outliers.map((o) => `${o.slug} ${o.celsius.toFixed(1)}C`).join(", ")}`);
    }

    survey.push({
      place: place.name,
      median: verdict.value,
      spread: verdict.spread,
      agreeing: verdict.agreeing,
      total: verdict.total,
      settles: verdict.ok,
      readings,
    });
  }

  const settling = survey.filter((s) => s.settles);
  console.log(`\n${settling.length}/${survey.length} places agree within the default ${DEFAULT_TOLERANCE}C tolerance`);
  if (settling.length) console.log(`  would settle: ${settling.map((s) => s.place).join(", ")}`);
  const held = survey.filter((s) => !s.settles);
  if (held.length) console.log(`  would hold:   ${held.map((s) => s.place).join(", ")}`);

  const out = { takenAt: new Date().toISOString(), toleranceC: DEFAULT_TOLERANCE, places: survey };
  writeFileSync(new URL("../build/survey.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log(`\n-> build/survey.json`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.shortMessage || e.message);
  process.exitCode = 1;
});
