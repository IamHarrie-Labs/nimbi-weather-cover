/**
 * Inspect and maintain the deployed contract.
 *
 *   node src/admin.js                 # pool + every policy
 *   node src/admin.js fund 20         # mint and add to the pool
 *   node src/admin.js cancel-open     # refund our own open policies
 *
 * `cancel-open` exists because an aborted test run leaves policies Open, and
 * every open policy reserves its payout against the pool. Six orphans reserved
 * the whole $5 and the next buy reverted with PoolTooThin.
 */

import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, formatUnits, parseUnits, decodeBytes32String, MaxUint256 } from "ethers";

const RPC = "https://sepolia.base.org";
const STATUS = ["Open", "PaidOut", "Expired", "Refunded"];

function loadEnv() {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const usd = (v) => "$" + formatUnits(v, 6);

async function main() {
  loadEnv();
  const deployment = JSON.parse(readFileSync(new URL("../build/deployment.json", import.meta.url), "utf8"));
  const artifact = JSON.parse(readFileSync(new URL("../build/WeatherGuard.json", import.meta.url), "utf8"));

  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  const guard = new Contract(deployment.address, artifact.abi, wallet);
  const token = new Contract(deployment.token, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function mint(address,uint256)",
  ], wallet);

  const [cmd, arg] = process.argv.slice(2);

  if (cmd === "fund") {
    const amount = parseUnits(arg || "10", 6);
    if ((await token.balanceOf(wallet.address)) < amount) {
      console.log(`minting ${usd(amount)}...`);
      await (await token.mint(wallet.address, amount)).wait();
    }
    await (await token.approve(deployment.address, MaxUint256)).wait();
    console.log(`funding pool with ${usd(amount)}...`);
    await (await guard.fundPool(amount)).wait();
  }

  const count = Number(await guard.policyCount());
  const openIds = [];

  console.log(`contract ${deployment.address}`);
  console.log(`policies ${count}\n`);

  for (let i = 0; i < count; i++) {
    const p = await guard.policies(i);
    const status = STATUS[Number(p.status)];
    if (status === "Open") openIds.push(i);
    const mine = p.holder.toLowerCase() === wallet.address.toLowerCase();
    console.log(
      `  #${String(i).padStart(2)}  ${status.padEnd(9)} ${decodeBytes32String(p.place).padEnd(10)}` +
        ` ${p.payAbove ? ">=" : "<="}${(Number(p.thresholdMilliC) / 1000).toFixed(1)}C`.padEnd(11) +
        `  premium ${usd(p.premium)}  payout ${usd(p.payout)}${mine ? "  (ours)" : ""}`,
    );
  }

  if (cmd === "cancel-open" && openIds.length) {
    console.log(`\ncancelling ${openIds.length} open policies...`);
    for (const id of openIds) {
      const p = await guard.policies(id);
      if (p.holder.toLowerCase() !== wallet.address.toLowerCase()) {
        console.log(`  #${id} skipped — not ours`);
        continue;
      }
      try {
        await (await guard.cancelPolicy(id)).wait();
        console.log(`  #${id} refunded ${usd(p.premium)}`);
      } catch (e) {
        console.log(`  #${id} failed: ${(e.shortMessage || e.message).slice(0, 60)}`);
      }
    }
  }

  const [free, reserved, bal, tolerance] = await Promise.all([
    guard.freeLiquidity(),
    guard.reserved(),
    token.balanceOf(deployment.address),
    guard.toleranceMilliC(),
  ]);
  console.log(`\npool     balance ${usd(bal)}   reserved ${usd(reserved)}   free ${usd(free)}`);
  console.log(`         tolerance ${Number(tolerance) / 1000}C   payout 5x`);
  console.log(`         a new policy needs free + premium >= payout`);
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage || e.message);
  process.exitCode = 1;
});
