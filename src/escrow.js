/**
 * Fund the Telegraph escrow so the WebSocket will authenticate.
 *
 * The socket refuses `ask` unless the wallet holds at least $1 USDC in the
 * Diamond's escrow. This does the two-step ERC-20 dance: approve the Diamond
 * to move the USDC, then deposit it.
 *
 *   node src/escrow.js            # show balances, change nothing
 *   node src/escrow.js deposit 1  # approve + deposit $1
 *
 * Reads AGENT_PRIVATE_KEY from .env. Testnet only.
 */

import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, Contract, formatUnits, parseUnits, MaxUint256 } from "ethers";

const RPC = "https://sepolia.base.org";
const DIAMOND = "0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8"; // Diamond (Port) — escrow, jobs, x402 receiver
// NOTE: the docs name Circle's canonical Base Sepolia USDC here
// (0x036CbD53842c5426634e7929541eC2318f3dCF7e). The Diamond does not use it.
// Always read usdcToken() off the contract — approving the documented token
// produces a deposit that reverts with "insufficient allowance", because the
// allowance was granted on a token the Diamond never touches.

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];
const DIAMOND_ABI = [
  "function escrowBalance(address) view returns (uint256)",
  "function depositUSDC(uint256)",
  "function usdcToken() view returns (address)",
];

function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env; fall back to real environment */
  }
}

const usd = (v) => "$" + formatUnits(v, 6);

async function main() {
  loadEnv();
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key || key.startsWith("0x...")) {
    console.error("Set AGENT_PRIVATE_KEY in weatherguard/.env first.");
    process.exitCode = 1;
    return;
  }

  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(key, provider);
  const diamond = new Contract(DIAMOND, DIAMOND_ABI, wallet);

  // Ask the contract which token it settles in, rather than assuming.
  const tokenAddress = await diamond.usdcToken();
  const usdc = new Contract(tokenAddress, ERC20, wallet);
  console.log(`token     ${tokenAddress}`);

  const [held, escrowed, allowance] = await Promise.all([
    usdc.balanceOf(wallet.address),
    diamond.escrowBalance(wallet.address),
    usdc.allowance(wallet.address, DIAMOND),
  ]);

  console.log(`wallet    ${wallet.address}`);
  console.log(`  held    ${usd(held)}`);
  console.log(`  escrow  ${usd(escrowed)}  ${escrowed >= 1_000_000n ? "-> WS auth OK" : "-> needs >= $1"}`);
  console.log(`  allowed ${usd(allowance)}`);

  const [cmd, amountArg] = process.argv.slice(2);

  if (cmd === "mint") {
    const amount = parseUnits(amountArg || "10", 6);
    console.log(`
minting ${usd(amount)} of the Diamond's token...`);
    const tx = await usdc.mint(wallet.address, amount);
    console.log(`  tx ${tx.hash}`);
    await tx.wait();
    console.log(`  held now ${usd(await usdc.balanceOf(wallet.address))}`);
    return;
  }

  if (cmd !== "deposit") {
    console.log("\nnothing changed. to fund:  node src/escrow.js deposit 1");
    return;
  }

  const amount = parseUnits(amountArg || "1", 6);
  if (held < amount) {
    console.error(
      `\nnot enough USDC: have ${usd(held)}, need ${usd(amount)}.` +
        `\nGet Base Sepolia USDC from faucet.circle.com first.`,
    );
    process.exitCode = 1;
    return;
  }

  if (allowance < amount) {
    console.log(`\napproving ${usd(amount)}...`);
    const tx = await usdc.approve(DIAMOND, amount);
    console.log(`  tx ${tx.hash}`);
    await tx.wait();
    console.log("  approved");
  }

  console.log(`depositing ${usd(amount)} into escrow...`);
  const tx = await diamond.depositUSDC(amount);
  console.log(`  tx ${tx.hash}`);
  await tx.wait();

  const after = await diamond.escrowBalance(wallet.address);
  console.log(`\nescrow now ${usd(after)}  ${after >= 1_000_000n ? "-> WS auth OK" : "-> still short"}`);
  console.log("note: escrow withdrawals have a 4-hour timelock.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
