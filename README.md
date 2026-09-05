# Nimbi

Parametric weather cover settled by consensus across independent Telegraph miners — not by trusting any single oracle's word.

A holder buys cover against a temperature threshold at a place. An off-chain agent asks six independent Telegraph miners the same question, checks whether they actually agree, and reports the result on-chain. A genuine majority agreeing and the threshold being breached pays out immediately. Disagreement gets held, and the reason is recorded — not silently retried, not guessed at.

**Live finding:** one miner, `chainsight-oracle`, reports a constant 40.50°C for Cairo, London, and Reykjavik alike. Not a measurement. Nimbi's consensus rule outvotes it, names it as excluded on-chain, and settles on the miners that actually agree.

Built for the [Telegraph Protocol Hackathon](https://hackathon.telegraphprotocol.com/), Season I, Application track. Live on Base Sepolia — testnet, play-money USDC. **Not insurance.** No real risk transfer, no underwriting.

## Structure

- `contracts/WeatherGuard.sol` — the settlement contract: holds premiums, reserves payouts, pays only on majority agreement + threshold breach, records disagreement instead of settling on it
- `src/consensus.js` — the majority-cluster agreement rule (median-anchored, strict-majority, minimum-cluster-size)
- `src/ask.js` — talks to Telegraph miners over the `ask_direct` WebSocket protocol
- `src/server.js` — backend: live consensus reads, the settlement ledger, and the settle-on-demand action (holds the agent's private key — never exposed to the browser)
- `public/` — the two-screen site: `index.html` (landing, read-only) and `buy.html` (wallet-gated buy flow)
- `src/deploy.js`, `src/admin.js`, `src/survey.js` — deployment, pool maintenance, and the multi-city miner survey that found the chainsight-oracle constant

## Running locally

```bash
npm install
cp .env.example .env   # fill in AGENT_PRIVATE_KEY — testnet only, never fund with mainnet assets
npm run server          # http://localhost:8787
```

## Deploying a fresh contract

```bash
node src/build.js        # compile
node src/deploy.js 20    # deploy + seed pool with $20 test USDC
node src/e2e.js cairo    # exercise all three settlement outcomes against live miners
```
