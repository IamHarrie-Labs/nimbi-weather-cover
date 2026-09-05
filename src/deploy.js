/**
 * Deploy WeatherGuard to Base Sepolia and seed its pool.
 *
 *   node src/build.js
 *   node src/deploy.js            # deploy + fund pool with $5
 *   node src/deploy.js 10         # deploy + fund with $10
 *
 * Writes build/deployment.json so the agent and frontend both know where the
 * contract lives.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ContractFactory, Contract, formatUnits, parseUnits, MaxUint256 } from "ethers";
import { agentWallet, retry, send } from "./rpc.js";

const RPC = "https://sepolia.base.org";

/**
 * Settlement token: the mock USDC the protocol's registry Diamond uses.
 *
 * Chosen over Circle's canonical testnet USDC for one reason — it exposes a
 * public `mint(address,uint256)`. Anyone can give themselves play money and
 * buy a policy in a single visit, with no faucet queue in the way. For a
 * demo whose whole point is that strangers try it, that matters more than
 * using the "official" testnet token.
 */
const TOKEN = "0xD0662CA1a427Aee7c302CA2265637fEf814528EE";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
  "function symbol() view returns (string)",
];

function loadEnv() {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const usd = (v) => "$" + formatUnits(v, 6);

async function main() {
  loadEnv();
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("AGENT_PRIVATE_KEY missing from .env");

  const wallet = agentWallet();
  const provider = wallet.provider;
  const artifact = JSON.parse(readFileSync(new URL("../build/WeatherGuard.json", import.meta.url), "utf8"));

  const seedAmount = parseUnits(process.argv[2] || "5", 6);
  const token = new Contract(TOKEN, ERC20, wallet);

  console.log(`deployer/agent  ${wallet.address}`);
  console.log(`token           ${TOKEN} (${await token.symbol()})`);
  console.log(`gas             ${formatUnits(await provider.getBalance(wallet.address), 18)} ETH`);

  // The deployer is also the agent here: one wallet reads the miners and
  // reports to the contract. Splitting them is a production concern.
  console.log(`\ndeploying...`);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const guard = await retry("deploy", async () => {
    const c = await factory.deploy(TOKEN, wallet.address);
    await c.waitForDeployment();
    return c;
  });
  const tx = guard.deploymentTransaction();
  console.log(`  tx ${tx.hash}`);
  const address = await guard.getAddress();
  console.log(`  deployed at ${address}`);

  // Seed the pool so the first policy has something to pay out of.
  let held = await token.balanceOf(wallet.address);
  if (held < seedAmount) {
    const need = seedAmount - held + parseUnits("5", 6);
    console.log(`\nminting ${usd(need)} to seed the pool...`);
    await send("mint", () => token.mint(wallet.address, need));
    held = await token.balanceOf(wallet.address);
  }

  console.log(`\nfunding pool with ${usd(seedAmount)}...`);
  await send("approve", () => token.approve(address, MaxUint256));

  // The approve was mined before this line and the node still served a stale
  // allowance to the very next call — fundPool reverted on a max approval that
  // was already on chain. Poll until the node admits the allowance exists.
  for (let i = 0; ; i++) {
    const allowed = await retry("allowance", () => token.allowance(wallet.address, address));
    if (allowed >= seedAmount) break;
    if (i === 9) throw new Error("approve mined but allowance still reads short");
    await new Promise((r) => setTimeout(r, 2000));
  }

  await send("fundPool", () => guard.fundPool(seedAmount));

  // Same staleness as the allowance above: the funding tx is mined, and the
  // node still reports an empty pool for a few seconds afterwards.
  let free = 0n;
  for (let i = 0; i < 8 && free < seedAmount; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    free = await retry("freeLiquidity", () => guard.freeLiquidity());
  }

  const [tolerance, minMiners, payoutBps] = await Promise.all([
    guard.toleranceMilliC(),
    guard.minMiners(),
    guard.payoutBps(),
  ]);

  console.log(`\nlive on Base Sepolia`);
  console.log(`  address         ${address}`);
  console.log(`  free liquidity  ${usd(free)}`);
  console.log(`  tolerance       ${Number(tolerance) / 1000}C spread between miners`);
  console.log(`  min miners      ${minMiners}`);
  console.log(`  payout          ${Number(payoutBps) / 10_000}x premium`);
  console.log(`  explorer        https://sepolia.basescan.org/address/${address}`);

  const deployment = {
    network: "base-sepolia",
    chainId: 84532,
    address,
    token: TOKEN,
    agent: wallet.address,
    deployedAt: new Date().toISOString(),
    txHash: tx.hash,
  };
  writeFileSync(new URL("../build/deployment.json", import.meta.url), JSON.stringify(deployment, null, 2));
  console.log(`\n-> build/deployment.json`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.shortMessage || e.message);
  process.exitCode = 1;
});
