# FlowLens

Real-time Solana trading volume dashboard. Tracks token activity across the major Solana DEX trading bots (Axiom, BullX, GMGN, Photon, Trojan, Maestro, Banana Gun, and more) by monitoring their fee wallets on-chain.

## What it does

- Polls each platform's fee wallets via Solana RPC to detect swaps as they happen
- Parses each transaction to extract the traded token, SOL amount, and direction (BUY/SELL)
- Aggregates volume per token per platform across time windows: 1m, 5m, 30m, 1h, 24h
- Surfaces the **highest-volume tokens** — both per platform ("Most Traded on Axiom") and globally ("Global Volume Leaders")
- Prices tokens via Jupiter Price API; falls back to SOL/USD estimation for unlisted tokens

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + TypeScript, Express (port 3001) |
| Database | SQLite via `better-sqlite3` |
| Frontend | Next.js (App Router), React, Tailwind v4, Framer Motion |
| RPC | Chainstack Solana mainnet |
| Price feeds | Pyth Hermes SSE (SOL/USD), Jupiter Price API v2 (tokens) |
| Platform sync | DefiLlama dimension-adapters (fee wallet discovery) |

## Project structure

```
flowlens/
├── src/
│   ├── index.ts                  # Express server, DB setup, API endpoints
│   ├── platforms.config.json     # DefiLlama URLs for fee wallet discovery
│   ├── platforms.json            # Synced fee wallet addresses (auto-generated)
│   └── services/
│       ├── ChainstackPoller.ts   # Core ingestion: polls wallets, parses swaps
│       ├── SyncService.ts        # Fetches fee wallets from DefiLlama adapters
│       ├── PriceService.ts       # SOL/USD via Pyth Hermes SSE
│       └── TokenPriceService.ts  # Token prices via Jupiter, with negative caching
├── frontend/
│   ├── src/app/page.tsx          # Main dashboard UI
│   └── next.config.ts            # Proxies /api/* → backend on port 3001
├── .env.example                  # Environment variable template
├── cursors.json                  # Poll cursors (auto-generated, gitignored)
└── flowlens.db                   # SQLite database (auto-created, gitignored)
```

## Setup

### 1. Prerequisites

- Node.js 20+
- A Solana RPC endpoint (Chainstack recommended for rate limits and archive access)

### 2. Clone and install

```bash
git clone <repo>
cd flowlens
npm install

cd frontend
npm install
cd ..
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
RPC_URL=https://solana-mainnet.core.chainstack.com/YOUR_KEY_HERE
PORT=3001
```

### 4. Run

In one terminal (backend):

```bash
npm run dev
```

In another terminal (frontend):

```bash
cd frontend && npm run dev
```

Open **http://localhost:3000**.

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/tokens` | Ranked token list by volume |
| `GET` | `/dashboard` | Per-platform aggregated stats |
| `GET` | `/platforms` | List of tracked platforms |
| `POST` | `/admin/sync` | Re-sync fee wallets from DefiLlama |

### `/tokens` query params

| Param | Default | Options |
|---|---|---|
| `window` | `1h` | `1m`, `5m`, `30m`, `1h`, `24h` |
| `platform` | `all` | `all` or any platform name |
| `sort` | `volume` | `volume`, `net`, `newest` |
| `limit` | `50` | max 200 |

When `platform=all`, tokens are aggregated across all platforms and ranked by total volume. The `dominant_platform` field indicates which platform contributed the most volume for each token.

## Adding platforms

Edit `src/platforms.config.json` to add a DefiLlama adapter URL for the platform:

```json
{
  "my-bot": "https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/my-bot.ts"
}
```

Then call `POST /admin/sync` to pull the fee wallet addresses.

If DefiLlama doesn't have an adapter for the platform, you can also edit `src/platforms.json` directly to add wallet addresses manually.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | Yes | Solana HTTPS RPC endpoint |
| `PORT` | No | Backend port (default: `3000`) |

**Never commit `.env`.** It is gitignored. Use `.env.example` as the template.

## Security notes

- `.env` (RPC key) is gitignored — keep it that way
- `flowlens.db` and `cursors.json` are gitignored (runtime state, no secrets)
- `platforms.json` contains only public on-chain wallet addresses — safe to commit
- `platforms.config.json` contains only public GitHub URLs — safe to commit
- The backend has no authentication on `/admin/sync` — do not expose port 3001 publicly
