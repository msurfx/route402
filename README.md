# Routex402: Verified reputation for AI agent payments

An unfakeable credit score for AI agents on Solana — only satisfied buyers can write it.

Routex402 is a protocol that lets AI agents check a seller's reputation before paying for services. Every reputation update requires the **buyer's wallet signature**, so sellers can't fake their own scores. Built on Solana devnet with the x402 HTTP 402 payment protocol.

## Live demo

**https://routex402.xyz**

Click **"Run purchase"** to trigger a real buyer→seller payment on Solana devnet. Watch the live protocol feed log every step: request → 402 challenge → payment → verification → delivery → reputation update.

> **Note:** Backend runs on Render free tier. First request after 15min idle takes 10-30s to wake up.

**On-chain program:** [`6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt`](https://solscan.io/account/6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt?cluster=devnet)

---

## What it does

**The problem:** AI agents are starting to pay each other for services — data, compute, APIs. But how does Agent A know Agent B won't take the money and return garbage?

**The solution:** Routex402 adds buyer-signed attestations on top of the x402 payment flow. A seller's reputation score can only change when the buyer's own wallet signs the update. No middleman, no admin key, no self-rating.

**One-liner:** Solscan tells you money moved. Routex402 tells you the agent is worth paying.

---

## Live agents

Five agents run on the platform right now, each pulling live Solana devnet data:

| Agent | Task | What it does |
|---|---|---|
| **Price Oracle** | `price-oracle` | Synthetic SOL/USDC price derived from network TPS, with 24h change and network health |
| **Network Report** | `network-report` | TPS, block height, epoch progress, performance samples |
| **Uptime Monitor** | `uptime-monitor` | RPC latency, network status, slots behind tip |
| **Whale Watcher** | `whale-watcher` | Top 10 devnet accounts by SOL balance |
| **Validator Score** | `validator-score` | Active validators, stake distribution, epoch credits |

All agents use the same x402 flow: request → 402 challenge → pay 0.01 USDC → verify → deliver → record reputation. Free preview endpoints power the homepage dashboard.

---

## Compatible ecosystem

Any Solana AI agent can plug into Routex402:

- **[Coral Protocol](https://coralprotocol.org)** — MCP-native agent marketplace with escrow payments
- **[SendAI](https://sendai.fun)** — Open-source toolkit connecting agents to 30+ Solana protocols
- **[Swarms](https://swarms.ai)** — Multi-agent collaboration platform
- **[Solana Agent Registry](https://solana.com/agent-registry)** — Official Solana agent directory
- **[Pay.sh](https://pay.sh)** — Stablecoin payment gateway for AI agent APIs
- **[Solana Agent Kit](https://github.com/solana-labs/solana-agent-kit)** — 50+ pre-built DeFi actions

---

## Architecture

```
program/              Anchor program: SellerProfile PDA + reputation logic
backend/seller/       Express server: 402 challenge, payment verification, 5 agent services
backend/buyer/        Purchase logic + demo button server
frontend/             Static HTML/CSS/JS: dashboard, explorer, live protocol feed
```

### x402 payment flow

```
Buyer requests service  →  Seller returns HTTP 402 + price + wallet
Buyer pays on Solana    →  Buyer retries with payment signature
Seller verifies on-chain →  Seller delivers result
Buyer signs reputation   →  On-chain score updated (buyer-attested)
```

### Deployed services

| Service | Host | Purpose |
|---|---|---|
| Seller agent | Render | 402 challenge, payment verification, 5 agent services, reputation writes |
| Buyer agent | Render | Executes purchases, exposes `/demo-purchase` |
| Frontend | Vercel | routex402.xyz — dashboard, explorer, live feed |
| Anchor program | Solana devnet | SellerProfile PDA, `record_payment`, `record_failure` |

---

## Running locally
## Aomi chat on the home page

The home page embeds the [Aomi](https://aomi.dev) chat widget (`frontend/aomi.js`,
loaded from esm.sh, no build step). A visitor signs in with a Solana wallet,
asks the agent to do something on-chain, and the page watches that wallet. When
a new confirmed transaction lands it is reported to the seller:

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/aomi/sessions` `{ wallet }` | A visitor signed in to the widget. Logged once per wallet as an `aomi_session` feed event. |
| `POST /api/v1/aomi/actions` `{ wallet, signature, cluster? }` | Verifies the transaction on-chain (confirmed, succeeded, wallet is a party) and logs an `aomi_action` feed event. Unverifiable signatures are rejected. |
| `GET /api/v1/aomi/activity?wallet=` | Totals and recent actions; `/api/v1/stats` also reports `aomiAgents` and `aomiActions`. |

The side panel then shows the agent's wallet, App ID, recent actions and a QR
code to continue on Telegram (`/link` attaches the wallet to the Aomi account)
or in Aomi Chat. Storage is in-memory, like the live feed.

Configure in `frontend/index.html`: `AOMI_APPLICATION_ID` (the activated
Routex402 App on Aomi; until set, the card shows a placeholder),
`AOMI_TELEGRAM_BOT` (bot username once registered on Aomi), and
`AOMI_SOLANA_RPCS` (clusters to watch; devnet by default).

## Running it locally

### Prerequisites

- Node.js 18+
- Rust + Solana CLI + Anchor CLI (pin to `0.30.1`: `avm install 0.30.1 && avm use 0.30.1`)

### Quick start

```bash
git clone https://github.com/msurfx/route402.git
cd route402

# Install
cd backend/seller && npm install && cd ../buyer && npm install && cd ../..

# Set up devnet wallets
solana config set --url devnet
solana-keygen new --no-bip39-passphrase -o backend/seller/seller-keypair.json
solana-keygen new --no-bip39-passphrase -o backend/buyer/buyer-keypair.json
solana airdrop 1 $(solana-keygen pubkey backend/seller/seller-keypair.json)
solana airdrop 1 $(solana-keygen pubkey backend/buyer/buyer-keypair.json)

# Run (3 terminals)
cd backend/seller && npm run dev      # :4021
cd backend/buyer && npm run serve     # :4022
cd frontend && npx http-server -p 5173
```

Open `http://localhost:5173?backend=local`

### API endpoints

```bash
# Free previews (no payment required)
curl https://route402-seller.onrender.com/preview/price
curl https://route402-seller.onrender.com/preview/uptime
curl https://route402-seller.onrender.com/preview/whales
curl https://route402-seller.onrender.com/preview/validators

# Paid service (requires x402 payment)
curl -X POST https://route402-seller.onrender.com/service \
  -H "Content-Type: application/json" \
  -d '{"task": "price-oracle"}'
# Returns 402 + payment requirements
```

### Cloud deployment

Both backends read keypairs from env vars (`SELLER_KEYPAIR_SECRET` / `BUYER_KEYPAIR_SECRET`) as JSON secret-key arrays. **Never commit keypair files.** They're in `.gitignore`.

---

## Known simplifications (hackathon build)

- `record_payment` trusts the signing authority — no on-chain payment proof (yet)
- Replay protection is in-memory, resets on restart
- No x402 facilitator — verification is direct against Solana devnet RPC
- Reputation formula is simple percentage, no decay or recency weighting
- Demo agent history is partly seeded via `scripts/seed-agent.ts`

See [SECURITY_ROADMAP.md](SECURITY_ROADMAP.md) for the hardening plan.

---

## Links

- **Live site:** https://routex402.xyz
- **Pitch deck:** [Google Slides](https://docs.google.com/presentation/d/1GvWJ6rleQPLb1GyJbQgu9UkdmJ0TiVEN3x9DBEZXuTs/edit?usp=sharing)
- **Solscan:** [Program on Solscan](https://solscan.io/account/6pp5jDS23FBcwtqe8pTiBJw3osyHZQPENr9bK3P62vjt?cluster=devnet)
- **X:** [@routex402](https://x.com/routex402)
