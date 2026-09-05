/**
 * Compile the settlement contract and write the artifact.
 *
 *   node src/build.js
 *
 * Emits build/WeatherGuard.json with abi + bytecode, which deploy.js and the
 * agent both read. No framework — one contract does not need Hardhat.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import solc from "solc";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NAME = "WeatherGuard";

const source = readFileSync(join(root, "contracts", `${NAME}.sol`), "utf8");

const input = {
  language: "Solidity",
  sources: { [`${NAME}.sol`]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris", // Base Sepolia is fine with this and it avoids PUSH0 surprises
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

const diagnostics = out.errors ?? [];
const errors = diagnostics.filter((e) => e.severity === "error");
for (const d of diagnostics) {
  if (d.severity !== "error") console.warn(`  ${d.severity}: ${d.formattedMessage.trim().split("\n")[0]}`);
}
if (errors.length) {
  for (const e of errors) console.error(`\n${e.formattedMessage}`);
  console.error(`${errors.length} compile error(s)`);
  process.exit(1);
}

const artifact = out.contracts[`${NAME}.sol`][NAME];
const bytecode = "0x" + artifact.evm.bytecode.object;

mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(
  join(root, "build", `${NAME}.json`),
  JSON.stringify({ abi: artifact.abi, bytecode }, null, 2),
);

const bytes = (bytecode.length - 2) / 2;
console.log(`compiled ${NAME}`);
console.log(`  solc      ${solc.version()}`);
console.log(`  bytecode  ${bytes} bytes  ${bytes > 24576 ? "!! over 24576 EIP-170 limit" : "(within EIP-170 limit)"}`);
console.log(`  abi       ${artifact.abi.length} entries`);
console.log(`  -> build/${NAME}.json`);
