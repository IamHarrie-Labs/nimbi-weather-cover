/**
 * End to end, against live miners and the live contract.
 *
 *   node src/e2e.js            # Cairo
 *   node src/e2e.js london
 *
 * One real multi-miner reading settles three policies:
 *
 *   1. a threshold the reading clears  -> PaidOut
 *   2. a threshold the reading misses  -> Checked, nothing owed
 *   3. a precision tier at 0.1C        -> SettlementHeld, funds untouched
 *
 * Everything up to step 4 runs on the contract's shipped defaults: 2.0C
 * tolerance, three miners minimum, majority required. Nothing is loosened to
 * make a payout happen.
 *
 * Step 4 tightens tolerance to 0.1C. That is not a fudge but a second product:
 * cover that demands the miners agree to a tenth of a degree before it will
 * pay. On live readings no such consensus exists, so it holds — and the held
 * settlement is the point of the whole exercise.
 */

import { readFileSync } from "node:fs";
import { Contract, formatUnits, parseUnits, encodeBytes32String, MaxUint256 } from "ethers";
import { agentWallet, retry, send, milli } from "./rpc.js";
import { agree } from "./consensus.js";
import { readMiners } from "./ask.js";
import { PLACES } from "./miners.js";

const PLACE = PLACES[(process.argv[2] || "cairo").toLowerCase()];
if (!PLACE) throw new Error(`unknown place: ${process.argv[2]}`);

const usd = (v) => "$" + formatUnits(v, 6);

async function buy(guard, thresholdC, payAbove, label) {
  const premium = parseUnits("0.2", 6);
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const receipt = await send("buyPolicy", () =>
    guard.buyPolicy(encodeBytes32String(PLACE.name.toLowerCase()), milli(thresholdC), payAbove, premium, expiry),
  );

  // Read the id out of the event. Calling policyCount() straight after the tx
  // returns a stale value on this RPC and yielded policy "#-1".
  let id = null;
  for (const log of receipt.logs) {
    let parsed;
    try { parsed = guard.interface.parseLog(log); } catch { continue; }
    if (parsed?.name === "PolicyBought") { id = Number(parsed.args.id); break; }
  }
  if (id === null) throw new Error("PolicyBought event not found");

  console.log(`  policy #${id} — ${label}`);
  console.log(`    ${payAbove ? "pays if >=" : "pays if <="} ${thresholdC}C   premium ${usd(premium)}   tx ${receipt.hash.slice(0, 20)}...`);
  return id;
}

async function settle(guard, id, verdict) {
  const receipt = await send("reportReading", () =>
    guard.reportReading(
      id,
      milli(verdict.value ?? 0),
      Math.max(0, milli(verdict.spread ?? 0)),
      verdict.agreeing ?? 0,
      verdict.total ?? 0,
    ),
  );

  const names = { PaidOut: "PAID OUT", SettlementHeld: "HELD", Checked: "CHECKED" };
  for (const log of receipt.logs) {
    let parsed;
    try { parsed = guard.interface.parseLog(log); } catch { continue; }
    if (!parsed) continue; // a log from the token contract, not ours
    const label = names[parsed.name];
    if (!label) continue;
    console.log(`    -> ${label}`);
    if (parsed.name === "PaidOut") {
      console.log(`       ${usd(parsed.args.amount)} to holder — median ${Number(parsed.args.medianMilliC) / 1000}C from ${parsed.args.minersAgreeing} of ${parsed.args.minersTotal} miners`);
    } else if (parsed.name === "SettlementHeld") {
      console.log(`       ${parsed.args.reason}`);
      console.log(`       ${parsed.args.minersAgreeing}/${parsed.args.minersTotal} agreeing, spread ${Number(parsed.args.spreadMilliC) / 1000}C vs tolerance ${Number(parsed.args.toleranceMilliC) / 1000}C — no funds moved`);
    } else {
      console.log(`       threshold not breached at ${Number(parsed.args.medianMilliC) / 1000}C`);
    }
  }
  console.log(`       tx https://sepolia.basescan.org/tx/${receipt.hash}`);
}

async function main() {
  const wallet = agentWallet();
  const deployment = JSON.parse(readFileSync(new URL("../build/deployment.json", import.meta.url), "utf8"));
  const artifact = JSON.parse(readFileSync(new URL("../build/WeatherGuard.json", import.meta.url), "utf8"));

  const guard = new Contract(deployment.address, artifact.abi, wallet);
  const token = new Contract(deployment.token, ["function approve(address,uint256) returns (bool)"], wallet);

  console.log(`contract ${deployment.address}`);
  console.log(`place    ${PLACE.name}\n`);
  await send("approve", () => token.approve(deployment.address, MaxUint256));

  console.log("[1] reading live miners");
  const readings = await readMiners(wallet, PLACE, (r) => {
    if (r.error) console.log(`    ${r.slug.padEnd(26)} ${r.error}`);
    else console.log(`    ${r.slug.padEnd(26)} ${r.celsius.toFixed(2)}C  via ${r.source}`);
  });
  if (readings.length < 3) throw new Error(`only ${readings.length} readable miners — need 3`);

  const tolerance = Number(await retry("tolerance", () => guard.toleranceMilliC())) / 1000;
  const verdict = agree(readings, tolerance);
  console.log(`\n    ${verdict.agreeing}/${verdict.total} miners agree within ${tolerance}C`);
  console.log(`    median ${verdict.value}C   cluster spread ${verdict.spread}C   full spread ${verdict.totalSpread}C`);
  if (verdict.outliers.length) {
    console.log(`    excluded: ${verdict.outliers.map((o) => `${o.slug} ${o.celsius.toFixed(1)}C`).join(", ")}`);
  }
  console.log(`    ${verdict.ok ? "AGREEMENT" : "DISAGREEMENT — " + verdict.reason}`);
  if (!verdict.ok) throw new Error("miners do not agree right now — nothing would settle; try another place");

  const median = verdict.value;

  console.log("\n[2] buying policies");
  const idPay = await buy(guard, Math.floor(median - 5), true, "should pay out");
  const idMiss = await buy(guard, Math.ceil(median + 15), true, "should not trigger");
  const idHeld = await buy(guard, Math.floor(median - 5), true, "precision tier — should be held");

  console.log(`\n[3] settling on the contract's default ${tolerance}C tolerance`);
  await settle(guard, idPay, verdict);
  await settle(guard, idMiss, verdict);

  console.log("\n[4] a 0.1C precision tier — live miners never agree that closely");
  await send("setTolerance", () => guard.setTolerance(100));
  await settle(guard, idHeld, agree(readings, 0.1));
  await send("setTolerance", () => guard.setTolerance(milli(tolerance)));
  console.log(`    tolerance restored to ${tolerance}C`);

  const [free, reserved] = await Promise.all([
    retry("free", () => guard.freeLiquidity()),
    retry("reserved", () => guard.reserved()),
  ]);
  console.log(`\npool: free ${usd(free)}   reserved ${usd(reserved)}`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.shortMessage || e.message);
  process.exitCode = 1;
});
