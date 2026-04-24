import http from 'http';
import express from 'express';
import type { RequestHandler } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

// ─── Global crash guards ──────────────────────────────────────────────────────
process.on('uncaughtException',  (err)    => logger.error({ err },    'uncaught exception'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));

// ─── Shared DB (must import before any service that uses it) ─────────────────
// import { db } from './db.js';
import { redis } from './redis/client.js';
import { logger } from './logger.js';
import { TokenPriceService } from './services/TokenPriceService.js';

// ─── Services & realtime stack ────────────────────────────────────────────────
import { PriceService } from './services/PriceService.js';
import { SyncService } from './services/SyncService.js';
import { BotGeyserSubscriber } from './grpc/BotGeyserSubscriber.js';
import { ChainstackPoller } from './services/ChainstackPoller.js';
import { VolumeBroadcaster } from './websocket/VolumeBroadcaster.js';
import { VolumeAggregator } from './aggregator/VolumeAggregator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── App + HTTP server ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const publicLimiter = rateLimit({ windowMs: 10_000, max: 30, standardHeaders: true, legacyHeaders: false });
const adminLimiter  = rateLimit({ windowMs: 60_000, max: 5,  standardHeaders: true, legacyHeaders: false });

// Admin auth: if ADMIN_SECRET is set, require `Authorization: Bearer <secret>`.
// Unset in dev to skip auth entirely.
const adminAuth: RequestHandler = (req, res, next) => {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) { next(); return; }
    if (req.headers.authorization !== `Bearer ${secret}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
};

// ─── Real-time stack ──────────────────────────────────────────────────────────
const broadcaster = new VolumeBroadcaster(server);
const aggregator  = new VolumeAggregator(broadcaster);

// ─── Startup ──────────────────────────────────────────────────────────────────
let geyserInstance: BotGeyserSubscriber | null = null;

(async () => {
    // Connect Redis adapter if configured (gracefully optional)
    if (process.env.REDIS_URL) {
        await broadcaster.connectRedis(process.env.REDIS_URL);
    }

    await SyncService.syncFeeWallets();
    aggregator.seedFromDb();
    PriceService.start();
    TokenPriceService.startBackgroundPricer();

    if (process.env.GEYSER_ENDPOINT && process.env.GEYSER_X_TOKEN) {
        logger.info('Yellowstone gRPC mode — RPC poller disabled');
        geyserInstance = new BotGeyserSubscriber();
        geyserInstance.setTradeHandler(trade => aggregator.ingest(trade));
        geyserInstance.start().catch(err => logger.error({ err }, 'gRPC start failed'));

        const platforms = Object.keys(SyncService.getLocalPlatforms());
        await broadcaster.restoreSnapshots(aggregator.allRooms(platforms));
    } else {
        const rpcUrl = process.env.RPC_URL?.trim() || '';
        if (!rpcUrl || rpcUrl.includes('your_chainstack_rpc_url')) {
            logger.error('Provide GEYSER_ENDPOINT or a valid RPC_URL in .env');
            process.exit(1);
        }
        logger.info('no GEYSER_ENDPOINT — using legacy RPC polling');
        const poller = new ChainstackPoller(rpcUrl);
        poller.start().catch(err => logger.error({ err }, 'poller failed'));
    }

    setInterval(async () => {
        logger.info('scheduled wallet re-sync');
        await SyncService.syncFeeWallets();
        if (geyserInstance) await geyserInstance.reloadWallets();
    }, 6 * 60 * 60 * 1_000);

    setInterval(() => {
        if (!geyserInstance) return;
        const s = geyserInstance.getStats();
        logger.info({ txs: s.txProcessed, uptimeMin: Math.floor(s.uptimeSeconds / 60), wallets: s.totalWallets, tpm: s.tradesPerMinute }, 'gRPC stats');
    }, 5 * 60 * 1_000);
})();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal: string) {
    logger.info({ signal }, 'shutting down gracefully');
    geyserInstance?.stop();
    server.close(async () => {
        await redis.quit();
        logger.info('shutdown complete');
        process.exit(0);
    });
    // Force-exit if server hasn't closed in 10s
    setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Helper ───────────────────────────────────────────────────────────────────
function getWindowStart(window: string): number {
    const now = Date.now();
    const map: Record<string, number> = {
        '1m':  now - 1  * 60 * 1000,
        '5m':  now - 5  * 60 * 1000,
        '30m': now - 30 * 60 * 1000,
        '1h':  now - 60 * 60 * 1000,
        '24h': now - 24 * 60 * 60 * 1000,
    };
    return map[window] ?? map['1h'];
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
    const stats = geyserInstance?.getStats() ?? null;
    const mem   = process.memoryUsage();
    res.json({
        status:          'ok',
        uptime:          Math.floor(process.uptime()),
        solPrice:        PriceService.getCurrentPrice(),
        memoryMb:        Math.round(mem.rss / 1024 / 1024),
        streamConnected: stats?.streamConnected ?? null,
        tradesPerMinute: stats?.tradesPerMinute ?? null,
        droppedTrades:   stats?.droppedTrades   ?? null,
        dropRatePct:     stats?.dropRatePct     ?? null,
        priceService:    TokenPriceService.getCircuitStatus(),
        redis: {
            status:  redis.status,
            prefix:  process.env.REDIS_PREFIX || 'flowlens:',
        },
        grpc: stats,
    });
});

app.post('/admin/sync', adminLimiter, adminAuth, async (_req, res) => {
    await SyncService.syncFeeWallets();
    if (geyserInstance) await geyserInstance.reloadWallets();
    res.json({ message: 'Sync + wallet reload complete' });
});

app.get('/admin/grpc-stats', adminLimiter, adminAuth, (_req, res) => {
    if (!geyserInstance) { res.json({ mode: 'rpc-polling', grpc: null }); return; }
    res.json({ mode: 'grpc', grpc: geyserInstance.getStats() });
});

app.get('/platforms', publicLimiter, (_req, res) => {
    res.json({ platforms: Object.keys(SyncService.getLocalPlatforms()) });
});

// WebSocket room discovery — tells clients exactly what rooms exist and how to use them.
app.get('/rooms', publicLimiter, (_req, res) => {
    const platforms = Object.keys(SyncService.getLocalPlatforms());
    const windows   = ['1m', '5m', '30m', '1h', '24h', 'overview'];
    const rooms: string[] = [];
    for (const w of windows) {
        rooms.push(`global-volume-${w}`);
        for (const p of platforms) rooms.push(`platform-${p}-${w}`);
    }
    res.json({
        wsUrl:  process.env.PUBLIC_WS_URL ?? `ws://localhost:${PORT}`,
        rooms,
        protocol: {
            connect:    'io(wsUrl, { transports: ["websocket"] })',
            join:       'socket.emit("join", roomName)',
            leave:      'socket.emit("leave", roomName)',
            onUpdate:   'socket.on("volume-update", payload => ...)',
            onReconnect: 'socket.on("connect", () => socket.emit("join", lastRoom))',
            payloadShape: {
                room:      'string  — e.g. "global-volume-1m" or "global-volume-overview"',
                timestamp: 'number  — ms epoch',
                tokens:    'TokenSnapshot[] (for regular rooms) OR Record<"1m"|"5m"|"30m"|"1h", TokenSnapshot[]> (for overview rooms)',
            },
            tokenShape: {
                mint: 'string', dominant_platform: 'string',
                total_volume_sol: 'number', total_volume_usd: 'number',
                net_sol: 'number', buy_count: 'number', sell_count: 'number',
                first_seen: 'number (ms epoch)',
            },
        },
    });
});

app.get('/tokens', publicLimiter, async (req, res) => {
    try {
        const windowParam   = (req.query.window   as string) || '1h';
        const platformParam = (req.query.platform as string) || 'all';
        const limit         = Math.min(parseInt((req.query.limit as string) || '50'), 200);
        const sortParam     = req.query.sort as string; // Redis currently handles 'volume' sort primarily

        const platform = platformParam === 'all' ? null : platformParam;
        const tokens   = await aggregator.getTopTokens(windowParam, platform);

        // Client-side sort fallback if needed (e.g. for 'net' or 'newest')
        if (sortParam === 'net') {
            tokens.sort((a, b) => Math.abs(b.net_sol) - Math.abs(a.net_sol));
        } else if (sortParam === 'newest') {
            tokens.sort((a, b) => b.first_seen - a.first_seen);
        }

        res.json({
            timestamp: Date.now(),
            window:    windowParam,
            platform:  platformParam,
            solPrice:  PriceService.getCurrentPrice(),
            tokens:    tokens.slice(0, limit),
        });
    } catch (error) {
        logger.error({ err: error }, 'tokens API error');
        res.status(500).send('Internal Server Error');
    }
});

app.get('/dashboard', publicLimiter, async (_req, res) => {
    try {
        const now = Date.now();
        const windows = ['1m', '5m', '30m', '1h', '24h'];
        const results: any = {};
        
        const platforms = Object.keys(SyncService.getLocalPlatforms());
        
        for (const platform of platforms) {
            const volumeData: any = {};
            let topToken = 'N/A';
            let topTokenVolume = 0;

            for (const win of windows) {
                const stats = await aggregator.getPlatformStats(platform, win);
                volumeData[win] = {
                    netSol:  stats.netSol,
                    netUsd:  stats.netUsd,
                    trades:  stats.trades,
                };
                if (win === '24h') {
                    topToken = stats.topToken;
                    topTokenVolume = stats.topVol;
                }
            }

            results[platform] = {
                volumes:         volumeData,
                topToken:        topToken,
                topTokenVolume:  topTokenVolume,
            };
        }

        res.json({ timestamp: now, solPrice: PriceService.getCurrentPrice(), platforms: results });
    } catch (error) {
        logger.error({ err: error }, 'dashboard API error');
        res.status(500).send('Internal Server Error');
    }
});

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`🚀 FlowLens WebSocket + REST LIVE on http://localhost:${PORT}`);
    console.log(`   → Will be accessible at http://80.190.80.155:${PORT} on VPS`);
});
