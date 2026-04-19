# FlowLens

Real-time Solana trading volume dashboard. Tracks token activity across the major Solana DEX trading bots (Axiom, BullX, GMGN, Photon, Trojan, Maestro, Banana Gun, and more) by monitoring their fee wallets on-chain.

## What it does

- Subscribes to fee wallet transactions via **Yellowstone gRPC** (Triton One) for sub-second latency; falls back to RPC polling if no gRPC endpoint is configured
- Parses each transaction to extract the traded token, SOL amount, and direction (BUY/SELL)
- Aggregates volume per token per platform in Redis across time windows: 1m, 5m, 30m, 1h, 24h
- Pushes live updates to frontend clients over **Socket.IO WebSockets** (room-based pub/sub)
- Surfaces the **highest-volume tokens** — both per platform ("Most Traded on Axiom") and globally ("Global Volume Leaders")
- Prices tokens via Jupiter Price API; falls back to SOL/USD estimation for unlisted tokens

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + TypeScript, Express (port 3001) |
| State / ranking | Redis via `ioredis` (sorted sets + hashes) |
| Real-time transport | Socket.IO (WebSocket, room-based) |
| Primary ingestion | Yellowstone gRPC (`@triton-one/yellowstone-grpc`) |
| Fallback ingestion | Chainstack Solana RPC polling |
| Frontend | Next.js (App Router), React, Tailwind v4 |
| Price feeds | Pyth Hermes SSE (SOL/USD), Jupiter Price API v2 (tokens) |
| Platform sync | DefiLlama dimension-adapters (fee wallet discovery) |
| Logging | Pino (JSON in prod, pretty in dev) |

## Project structure

```
flowlens/
├── src/
│   ├── index.ts                      # Express server, HTTP → WS bridge, API endpoints
│   ├── types.ts                      # Shared TypeScript types (TradeEvent, TokenSnapshot, etc.)
│   ├── logger.ts                     # Pino logger setup
│   ├── platforms.config.json         # DefiLlama URLs + enabled list for fee wallet discovery
│   ├── platforms.json                # Synced fee wallet addresses (auto-generated)
│   ├── grpc/
│   │   └── BotGeyserSubscriber.ts    # Yellowstone gRPC subscriber — streams fee wallet txs
│   ├── aggregator/
│   │   └── VolumeAggregator.ts       # Ingests trades → Redis sorted sets, throttled WS broadcast
│   ├── websocket/
│   │   └── VolumeBroadcaster.ts      # Socket.IO server, room management, snapshot replay
│   ├── redis/
│   │   └── client.ts                 # Shared ioredis instance
│   └── services/
│       ├── ChainstackPoller.ts       # Legacy RPC fallback ingestion
│       ├── SyncService.ts            # Fetches fee wallets from DefiLlama adapters
│       ├── PriceService.ts           # SOL/USD via Pyth Hermes SSE
│       └── TokenPriceService.ts      # Token prices via Jupiter, with background pricing queue
├── frontend/
│   ├── src/app/page.tsx              # Main dashboard UI
│   └── next.config.ts               # Proxies /api/* → backend on port 3001
├── scratch/                          # Dev / debug scripts (not production)
├── .env.example                      # Environment variable template
└── cursors.json                      # RPC poll cursors (auto-generated, gitignored)
```

## Real-time WebSocket protocol

Clients connect via Socket.IO and join named **rooms**. Each room maps to a platform + time window combination. The server pushes `volume-update` events into the room whenever aggregated data changes (throttled to ~1s).

```
Room names:
  global-volume-{window}          — e.g. "global-volume-1h"
  platform-{name}-{window}        — e.g. "platform-axiom-5m"

Windows: 1m | 5m | 30m | 1h | 24h
```

```ts
const socket = io(WS_URL, { transports: ['websocket'] });
socket.emit('join', 'global-volume-1h');
socket.on('volume-update', ({ room, timestamp, tokens }) => { /* ... */ });
// On reconnect:
socket.on('connect', () => socket.emit('join', lastRoom));
```

Each `TokenSnapshot` in the `tokens` array:

| Field | Type | Description |
|---|---|---|
| `mint` | string | Token mint address |
| `dominant_platform` | string | Platform with most volume for this token |
| `total_volume_sol` | number | SOL volume in the time window |
| `total_volume_usd` | number | USD volume (approximate) |
| `net_sol` | number | Buy SOL − Sell SOL |
| `buy_count` | number | Number of buy trades |
| `sell_count` | number | Number of sell trades |
| `first_seen` | number | ms epoch of first observed trade |

Use `GET /rooms` to discover all available room names and the current WebSocket URL.

## Setup

### 1. Prerequisites

- Node.js 20+
- Redis 7+ (local or hosted)
- A Yellowstone gRPC endpoint **or** a Solana HTTPS RPC (Chainstack recommended)

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

Edit `.env` — at minimum set one ingestion source and Redis:

```env
# Primary ingestion (preferred — sub-second latency)
GEYSER_ENDPOINT=https://your-chainstack-geyser-endpoint
GEYSER_X_TOKEN=your-x-token

# Fallback ingestion (used only if GEYSER_ENDPOINT is absent)
# RPC_URL=https://solana-mainnet.core.chainstack.com/YOUR_KEY_HERE

# Redis (required)
REDIS_URL=redis://localhost:6379

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

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Health check with gRPC stats, memory, price service status |
| `GET` | `/rooms` | — | WebSocket room discovery + protocol reference |
| `GET` | `/tokens` | — | Ranked token list by volume (Redis) |
| `GET` | `/dashboard` | — | Per-platform aggregated stats across all windows |
| `GET` | `/platforms` | — | List of tracked platforms |
| `POST` | `/admin/sync` | Bearer | Re-sync fee wallets from DefiLlama + hot-reload gRPC |
| `GET` | `/admin/grpc-stats` | Bearer | Live gRPC stream stats (tx rate, drop rate, uptime) |

Admin endpoints require `Authorization: Bearer <ADMIN_SECRET>` when `ADMIN_SECRET` is set. Leave it unset in dev to skip auth.

### `/tokens` query params

| Param | Default | Options |
|---|---|---|
| `window` | `1h` | `1m`, `5m`, `30m`, `1h`, `24h` |
| `platform` | `all` | `all` or any platform name |
| `sort` | `volume` | `volume`, `net`, `newest` |
| `limit` | `50` | max 200 |

## Adding platforms

Edit `src/platforms.config.json` to add a DefiLlama adapter URL for the platform:

```json
{
  "platforms": [
    { "name": "my-bot", "url": "https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/my-bot.ts", "enabled": true }
  ]
}
```

Then call `POST /admin/sync` to pull the fee wallet addresses. Wallets are also re-synced automatically every 6 hours.

If DefiLlama doesn't have an adapter for the platform, edit `src/platforms.json` directly to add wallet addresses manually.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEYSER_ENDPOINT` | One of these two | Yellowstone gRPC endpoint (preferred) |
| `RPC_URL` | One of these two | Solana HTTPS RPC (legacy polling fallback) |
| `REDIS_URL` | Yes | Redis connection string (default: `redis://localhost:6379`) |
| `REDIS_PREFIX` | No | Redis key namespace (default: `flowlens:`) |
| `PORT` | No | Backend port (default: `3000`) |
| `CORS_ORIGINS` | No | Comma-separated allowed origins; unset = allow all |
| `ADMIN_SECRET` | No | Bearer token for `/admin/*`; unset = no auth (dev only) |
| `PUBLIC_WS_URL` | No | Publicly reachable WebSocket URL (used by `/rooms`) |
| `DISCORD_WEBHOOK_URL` | No | Discord webhook for gRPC stream failure alerts |
| `LOG_LEVEL` | No | `trace` / `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | No | Set to `production` for JSON logs (disables pino-pretty) |

**Never commit `.env`.** It is gitignored. Use `.env.example` as the template.

## Security notes

- `.env` (RPC key, gRPC token, admin secret) is gitignored — keep it that way
- `cursors.json` is gitignored (runtime state, no secrets)
- `platforms.json` contains only public on-chain wallet addresses — safe to commit
- `platforms.config.json` contains only public GitHub URLs — safe to commit
- Set `ADMIN_SECRET` and restrict `CORS_ORIGINS` before exposing the backend publicly
- Rate limits: 30 req/10s on public endpoints, 5 req/min on admin endpoints
