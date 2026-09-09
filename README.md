# Nimbi

Parametric weather cover settled by consensus across independent Telegraph miners, not by trusting any single oracle's word.

A holder buys cover against a temperature threshold at a place. An off-chain agent asks six independent Telegraph miners the same question, checks whether they actually agree, and reports the result on-chain. A genuine majority agreeing and the threshold being breached pays out immediately. Disagreement gets held, and the reason is recorded, not silently retried, not guessed at.

**Live finding:** one miner, `chainsight-oracle`, reports a constant 40.50°C for Cairo, London, and Reykjavik alike. Not a measurement. Nimbi's consensus rule outvotes it, names it as excluded on-chain, and settles on the miners that actually agree.

Built for the [Telegraph Protocol Hackathon](https://hackathon.telegraphprotocol.com/), Season I, Application track. Live on Base Sepolia, testnet, play-money USDC. **Not insurance.** No real risk transfer, no underwriting.

**Live site:** https://nimbi-project.onrender.com/
**Landing:** `/` · **Buy cover:** `/buy` · **Docs:** `/docs`

## Structure

- `contracts/WeatherGuard.sol`: the settlement contract. Holds premiums, reserves payouts, pays only on majority agreement plus threshold breach, records disagreement instead of settling on it.
- `src/consensus.js`: the majority-cluster agreement rule (median-anchored, strict-majority, minimum-cluster-size).
- `src/ask.js`: talks to Telegraph miners over the `ask_direct` WebSocket protocol.
- `src/miners.js`: the six miner subnet IDs and the places Nimbi prices (Cairo, Lagos, London, Singapore, Reykjavik).
- `src/server.js`: the backend. Live consensus reads, the settlement ledger, and the settle-on-demand action. Holds the agent's private key, which is never exposed to the browser.
- `public/`: the site. `index.html` is the landing page (read-only, no wallet needed), `buy.html` is the wallet-gated buy and settle flow, `docs.html` is the plain-language explanation, and `styles.css`, `motion.js`, `app.js` are shared across all three.
- `src/deploy.js`, `src/admin.js`, `src/escrow.js`, `src/survey.js`: deployment, pool maintenance, Telegraph escrow funding, and the multi-city miner survey that found the chainsight-oracle constant.

## Running locally

```bash
npm install
cp .env.example .env   # fill in AGENT_PRIVATE_KEY (testnet only, never fund with mainnet assets)
npm run server          # http://localhost:8787
```

## Deploying a fresh contract

```bash
node src/build.js        # compile
node src/deploy.js 20    # deploy + seed pool with $20 test USDC
node src/e2e.js cairo    # exercise all three settlement outcomes against live miners
```

## Keeping the Telegraph escrow funded

Every `ask_direct` call to a miner costs a small x402 micropayment, drawn from the agent wallet's escrow balance on Telegraph's Diamond contract, not from the pool that backs payouts. Enough traffic (testing, demos, real visitors settling policies) will drain it, and once it's empty every consensus read and settlement fails with `insufficient escrow for delivery`.

Check the balance and top it up from the wallet's own USDC:

```bash
node src/escrow.js            # show current balance, change nothing
node src/escrow.js deposit 10 # approve + deposit $10 more
```

After a deposit, give it a minute or two: the on-chain balance updates immediately, but Telegraph's own backend can take a short while to notice it.

## Known limitations

- **Cold start.** The live site runs on Render's free tier, which sleeps after inactivity. The first request after a while can take 30 to 60 seconds to wake it up.
- **Live miner data is genuinely live.** Readings, which miners answer, and how far apart they land all vary between requests because they reflect real weather feeds, not fixtures. A settlement occasionally holds simply because the miners disagreed at that moment, which is the point, not a bug.
- **Testnet only.** Base Sepolia, play-money USDC, no real funds anywhere in this system.
