import express from 'express';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import cors from 'cors';
import { PriceService } from './services/PriceService';
import { SyncService } from './services/SyncService';
import { TokenPriceService } from './services/TokenPriceService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Startup sequence
(async () => {
  await SyncService.syncFeeWallets();
  PriceService.start();
})();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Database Setup (Fix #7: Pre-aggregation View) ---
const dbPath = path.join(__dirname, '..', 'flowlens.db');
const db = new Database(dbPath);

db.prepare(`
    CREATE TABLE IF NOT EXISTS platform_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signature TEXT UNIQUE,
        timestamp INTEGER,
        platform TEXT,
        token_mint TEXT,
        sol_amount REAL,
        direction TEXT,
        usd_value REAL,
        usd_estimated INTEGER NOT NULL DEFAULT 0,
        raw_data TEXT
    )
`).run();

// Non-destructive migration: add usd_estimated column to existing DBs
try {
    db.prepare(`ALTER TABLE platform_events ADD COLUMN usd_estimated INTEGER NOT NULL DEFAULT 0`).run();
} catch { /* column already exists */ }

db.prepare(`CREATE INDEX IF NOT EXISTS idx_platform_timestamp ON platform_events(platform, timestamp)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_token_timestamp ON platform_events(token_mint, timestamp)`).run();

// --- Configuration Helper ---
let walletToPlatform: Record<string, string> = {};

function refreshPlatformMap() {
    const platforms = SyncService.getLocalPlatforms();
    walletToPlatform = {};
    for (const [platform, wallets] of Object.entries(platforms)) {
        (wallets as string[]).forEach(wallet => {
            walletToPlatform[wallet.toLowerCase()] = platform;
        });
    }
}
refreshPlatformMap();

import { ChainstackPoller } from './services/ChainstackPoller.js';

// --- Poller Setup ---
const rpcUrl = process.env.RPC_URL?.trim();

if (!rpcUrl || rpcUrl.includes('your_chainstack_rpc_url')) {
    console.error("❌ ERROR: You must provide a valid Chainstack HTTPS URL in your .env file.");
    process.exit(1);
}

if (!rpcUrl.startsWith('http')) {
    console.error("❌ ERROR: RPC_URL must start with 'http:' or 'https:'. Current value: " + rpcUrl);
    process.exit(1);
}
const poller = new ChainstackPoller(rpcUrl);

// Start the poller asynchronously
poller.start().catch(err => console.error("Poller failed to start:", err));

// --- Endpoints ---

app.post('/admin/sync', async (req, res) => {
    await SyncService.syncFeeWallets();
    refreshPlatformMap();
    res.json({ message: "Sync complete", count: Object.keys(walletToPlatform).length });
});

// --- Time window helper ---
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

// --- /platforms ---
app.get('/platforms', (_req, res) => {
    const platforms = SyncService.getLocalPlatforms();
    res.json({ platforms: Object.keys(platforms) });
});

// --- /tokens ---
app.get('/tokens', (req, res) => {
    try {
        const windowParam  = (req.query.window   as string) || '1h';
        const platformParam = (req.query.platform as string) || 'all';
        const limit        = Math.min(parseInt((req.query.limit as string) || '50'), 200);
        const sortParam    = req.query.sort as string;

        // Sort options: volume (default) | net | newest
        const orderClause =
            sortParam === 'net'    ? 'net_sol DESC' :
            sortParam === 'newest' ? 'first_seen DESC' :
            'total_sol DESC';

        const startTime = getWindowStart(windowParam);

        const AGGREGATES = `
                SUM(CASE WHEN direction = 'BUY'  THEN sol_amount ELSE 0 END)           AS buy_sol,
                SUM(CASE WHEN direction = 'SELL' THEN sol_amount ELSE 0 END)           AS sell_sol,
                SUM(CASE WHEN direction = 'BUY'  THEN sol_amount ELSE -sol_amount END) AS net_sol,
                SUM(CASE WHEN direction = 'BUY'  THEN usd_value  ELSE -usd_value  END) AS net_usd,
                SUM(sol_amount)  AS total_sol,
                SUM(usd_value)   AS total_volume_usd,
                COUNT(*)         AS trade_count,
                SUM(CASE WHEN direction = 'BUY'  THEN 1 ELSE 0 END) AS buy_count,
                SUM(CASE WHEN direction = 'SELL' THEN 1 ELSE 0 END) AS sell_count,
                MIN(timestamp)   AS first_seen,
                MAX(usd_estimated) AS usd_estimated
        `;

        let rows: any[];
        if (platformParam === 'all') {
            // Aggregate across all platforms; correlated subquery finds the top platform per token.
            // Parameters: startTime (subquery), startTime (outer WHERE), limit
            rows = db.prepare(`
                SELECT
                    token_mint,
                    (
                        SELECT sub.platform
                        FROM platform_events sub
                        WHERE sub.token_mint = main.token_mint AND sub.timestamp >= ?
                        GROUP BY sub.platform
                        ORDER BY SUM(sub.sol_amount) DESC
                        LIMIT 1
                    ) AS dominant_platform,
                    ${AGGREGATES}
                FROM platform_events main
                WHERE main.timestamp >= ?
                GROUP BY token_mint
                ORDER BY ${orderClause}
                LIMIT ?
            `).all(startTime, startTime, limit);
        } else {
            // Single platform: filter by platform, group by token only
            rows = db.prepare(`
                SELECT
                    token_mint,
                    platform,
                    ${AGGREGATES}
                FROM platform_events
                WHERE timestamp >= ? AND platform = ?
                GROUP BY token_mint
                ORDER BY ${orderClause}
                LIMIT ?
            `).all(startTime, platformParam, limit);
        }

        res.json({
            timestamp: Date.now(),
            window: windowParam,
            platform: platformParam,
            solPrice: PriceService.getCurrentPrice(),
            tokens: rows,
        });
    } catch (error) {
        console.error('Tokens API Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/dashboard', (req, res) => {
    try {
        const now = Date.now();
        const intervals = {
            '1m':  now - 1  * 60 * 1000,
            '5m':  now - 5  * 60 * 1000,
            '30m': now - 30 * 60 * 1000,
            '1h':  now - 60 * 60 * 1000,
            '24h': now - 24 * 60 * 60 * 1000
        };

        const platforms = SyncService.getLocalPlatforms();
        const results: any = {};

        for (const platform of Object.keys(platforms)) {
            const volumeData: any = {};
            for (const [label, startTime] of Object.entries(intervals)) {
                const row = db.prepare(`
                    SELECT 
                        SUM(CASE WHEN direction = 'BUY' THEN sol_amount ELSE -sol_amount END) as net_sol,
                        SUM(CASE WHEN direction = 'BUY' THEN usd_value ELSE -usd_value END) as net_usd,
                        COUNT(*) as trade_count
                    FROM platform_events
                    WHERE platform = ? AND timestamp >= ?
                `).get(platform, startTime) as any;

                volumeData[label] = {
                    netSol: row?.net_sol || 0,
                    netUsd: row?.net_usd || 0,
                    trades: row?.trade_count || 0
                };
            }

            const topTokenRow = db.prepare(`
                SELECT token_mint, SUM(sol_amount) as total_vol
                FROM platform_events
                WHERE platform = ? AND timestamp >= ?
                GROUP BY token_mint
                ORDER BY total_vol DESC
                LIMIT 1
            `).get(platform, intervals['24h']) as any;

            results[platform] = {
                volumes: volumeData,
                topToken: topTokenRow?.token_mint || 'N/A',
                topTokenVolume: topTokenRow?.total_vol || 0
            };
        }

        res.json({
            timestamp: now,
            solPrice: PriceService.getCurrentPrice(),
            platforms: results
        });
    } catch (error) {
        console.error('Dashboard API Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 FlowLens Core LIVE on ${PORT}`);
    console.log(`💹 Jupiter-Enabled Token Pricing Active`);
    console.log(`🛡️ Platform Auto-Syncing Active`);
});
