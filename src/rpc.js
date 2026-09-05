/**
 * Shared chain plumbing.
 *
 * Base Sepolia's public RPC drops connections often enough that any script
 * doing more than two transactions in a row will hit one. Every failure seen
 * so far has been transport-level — SSL record errors, resets — and the same
 * call succeeds moments later. Contract reverts are never retried; those are
 * real answers and should surface immediately.
 */

import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet } from "ethers";

export const RPC = "https://sepolia.base.org";

const TRANSIENT = /SSL|EPROTO|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network error|timeout|could not coalesce|failed to detect network|SERVER_ERROR/i;

export function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* fall back to the real environment */
  }
}

export function provider() {
  return new JsonRpcProvider(RPC);
}

export function agentWallet() {
  loadEnv();
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("AGENT_PRIVATE_KEY missing from weatherguard/.env");
  return new Wallet(key, provider());
}

/** Retry a transport failure; surface anything else at once. */
export async function retry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e.shortMessage || e.message || "";
      if (!TRANSIENT.test(msg) || i >= attempts) throw e;
      console.log(`    (${label}: network error, retry ${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
}

/** Send a transaction and wait for it, retrying transport failures. */
export async function send(label, fn, attempts = 5) {
  return retry(label, async () => {
    const tx = await fn();
    return tx.wait();
  }, attempts);
}

export const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
export const milli = (celsius) => Math.round(celsius * 1000);
