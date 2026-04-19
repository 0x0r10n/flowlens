import YellowstoneGrpc from "@triton-one/yellowstone-grpc";
const Client = (YellowstoneGrpc as any).default || YellowstoneGrpc;

import { readFileSync, existsSync } from "fs";
import { PublicKey } from "@solana/web3.js";
import path from 'path';
import { fileURLToPath } from 'url';
import { TokenPriceService } from '../services/TokenPriceService.js';
import { PriceService } from '../services/PriceService.js';
// import { insertEvent } from '../db.js';
import { logger } from '../logger.js';
import type { TradeEvent } from '../aggregator/VolumeAggregator.js';
import bs58 from "bs58";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const MAX_ACCOUNTS      = 48;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;
const WATCHDOG_MS       = 5 * 60 * 1_000;
const WSOL              = 'So11111111111111111111111111111111111111112';

interface PlatformWallets {
    name: string;
    feeWallets: string[];
}

export class BotGeyserSubscriber {
    private endpoint: string;
    private xToken: string;
    private client: any = null;
    private currentStream: any = null;
    private platforms: PlatformWallets[] = [];
    private walletToPlatform: Record<string, string> = {};

    private onTrade: ((t: TradeEvent) => void) | null = null;
    private reconnectMs    = RECONNECT_BASE_MS;
    private isShuttingDown = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingInterval:   NodeJS.Timeout | null = null;
    private watchdogTimer:  NodeJS.Timeout | null = null;
    private pingCounter   = 0;
    private txCount       = 0;
    private droppedTrades = 0;
    private startedAt     = 0;

    constructor() {
        this.endpoint = process.env.GEYSER_ENDPOINT!;
        this.xToken   = process.env.GEYSER_X_TOKEN!;
    }

    setTradeHandler(fn: (t: TradeEvent) => void) { this.onTrade = fn; }

    // ─── Platform loading ─────────────────────────────────────────────────────

    loadPlatforms(): number {
        const platformsPath = path.join(__dirname, '..', 'platforms.json');
        if (!existsSync(platformsPath)) {
            logger.error('platforms.json not found — run sync first');
            return 0;
        }

        const allPlatforms = JSON.parse(readFileSync(platformsPath, "utf-8"));
        const config       = JSON.parse(readFileSync(path.join(__dirname, '..', 'platforms.config.json'), "utf-8"));

        const enabledNames: string[] = config.platforms
            .filter((p: any) => p.enabled !== false)
            .map((p: any) => p.name);

        this.platforms = [];
        this.walletToPlatform = {};
        let totalAccounts = 0;

        for (const name of enabledNames) {
            const rawWallets: string[] | undefined = allPlatforms[name];
            if (!rawWallets?.length) continue;

            const wallets = rawWallets.filter(w => {
                try {
                    if (new PublicKey(w).toBytes().length !== 32) return false;
                    if (w === WSOL) return false;
                    return true;
                } catch {
                    logger.warn({ platform: name, pubkey: w.slice(0, 20) }, 'invalid pubkey skipped');
                    return false;
                }
            });

            if (!wallets.length) continue;

            const remaining = MAX_ACCOUNTS - totalAccounts;
            if (remaining <= 0) {
                logger.warn({ platform: name }, `account limit (${MAX_ACCOUNTS}) reached — skipping`);
                continue;
            }

            const slice = wallets.slice(0, remaining);
            this.platforms.push({ name, feeWallets: slice });
            slice.forEach(w => { this.walletToPlatform[w] = name; });
            totalAccounts += slice.length;
        }

        return totalAccounts;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async start() {
        if (this.isShuttingDown) return;
        this.clearReconnectTimer();

        try { this.client?.close?.(); } catch {}
        this.client = null;
        this.currentStream = null;

        const totalAccounts = this.loadPlatforms();
        if (totalAccounts === 0) {
            logger.error('no fee wallets loaded — retrying');
            this.scheduleReconnect();
            return;
        }

        logger.info({ total: totalAccounts, max: MAX_ACCOUNTS, platforms: this.platforms.length }, 'gRPC account slots');
        this.platforms.forEach(p => logger.info({ platform: p.name, wallets: p.feeWallets.length }, 'platform loaded'));

        try {
            this.client = new Client(this.endpoint, this.xToken, {
                grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
            });
            await this.client.connect();
            logger.info('connected to Yellowstone gRPC');
            this.reconnectMs = RECONNECT_BASE_MS;
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'gRPC connect failed');
            this.scheduleReconnect();
            return;
        }

        try {
            const stream = await this.client.subscribe();
            this.currentStream = stream;
            this.startedAt = Date.now();
            this.txCount   = 0;

            const allFeeWallets = Object.keys(this.walletToPlatform);

            stream.write({
                accounts: {},
                transactions: {
                    "bot-swaps": {
                        vote: false, failed: false,
                        accountInclude: allFeeWallets,
                        accountExclude: [], accountRequired: [],
                    },
                },
                entry: {}, slots: {}, blocks: {}, blocksMeta: {},
                transactionsStatus: {}, commitment: 0, accountsDataSlice: [],
            });

            logger.info({ wallets: allFeeWallets.length }, 'gRPC subscription active');
            this.resetWatchdog(stream);

            this.clearPingInterval();
            this.pingInterval = setInterval(() => {
                try {
                    stream.write({
                        ping: { id: ++this.pingCounter % 1_000_000 },
                        accounts: {}, transactions: {}, entry: {}, slots: {},
                        blocks: {}, blocksMeta: {}, transactionsStatus: {},
                        commitment: 0, accountsDataSlice: [],
                    });
                } catch { /* stream closed */ }
            }, 15_000);

            const cleanup = (reason: string) => {
                if (!this.currentStream) return;
                logger.warn({ reason }, 'gRPC stream closed');
                this.currentStream = null;
                this.clearPingInterval();
                this.clearWatchdog();
                this.scheduleReconnect();
            };

            stream.on("data", (data: any) => {
                if (data.transaction) {
                    this.resetWatchdog(stream);
                    try {
                        this.handleTransaction(data.transaction);
                    } catch (err: any) {
                        if (!err?.message?.includes('UNIQUE constraint')) {
                            logger.error({ err: err.message }, 'tx processing error');
                        }
                    }
                }
            });

            stream.on("error", (err: any) => {
                logger.error({ err: err?.message ?? String(err) }, 'gRPC stream error');
                cleanup("errored");
            });
            stream.on("end",   () => cleanup("ended unexpectedly"));
            stream.on("close", () => cleanup("closed"));

        } catch (err) {
            logger.error({ err: (err as Error).message }, 'gRPC subscribe failed');
            this.scheduleReconnect();
        }
    }

    stop() {
        this.isShuttingDown = true;
        this.clearPingInterval();
        this.clearWatchdog();
        this.clearReconnectTimer();
        try { this.currentStream?.destroy?.(); } catch {}
        try { this.client?.close?.(); } catch {}
        logger.info('gRPC subscriber stopped');
    }

    async reloadWallets() {
        const total = this.loadPlatforms();
        if (total === 0 || !this.currentStream) return;
        const allFeeWallets = Object.keys(this.walletToPlatform);
        try {
            this.currentStream.write({
                accounts: {},
                transactions: {
                    "bot-swaps": {
                        vote: false, failed: false,
                        accountInclude: allFeeWallets,
                        accountExclude: [], accountRequired: [],
                    },
                },
                entry: {}, slots: {}, blocks: {}, blocksMeta: {},
                transactionsStatus: {}, commitment: 0, accountsDataSlice: [],
            });
            logger.info({ wallets: allFeeWallets.length }, 'gRPC wallet list hot-reloaded');
        } catch (err) {
            logger.error({ err: (err as Error).message }, 'reloadWallets failed');
        }
    }

    getStats() {
        const uptimeSec  = (Date.now() - this.startedAt) / 1000;
        const total      = this.txCount + this.droppedTrades;
        const dropRate   = total > 0 ? Math.round((this.droppedTrades / total) * 1000) / 10 : 0;
        return {
            txProcessed:     this.txCount,
            droppedTrades:   this.droppedTrades,
            dropRatePct:     dropRate,
            tradesPerMinute: uptimeSec > 0 ? Math.round((this.txCount / uptimeSec) * 60 * 10) / 10 : 0,
            uptimeSeconds:   Math.floor(uptimeSec),
            streamConnected: this.currentStream !== null,
            platforms:       this.platforms.map(p => ({ name: p.name, wallets: p.feeWallets.length })),
            totalWallets:    Object.keys(this.walletToPlatform).length,
        };
    }

    // ─── Watchdog ─────────────────────────────────────────────────────────────

    private resetWatchdog(stream: any) {
        this.clearWatchdog();
        this.watchdogTimer = setTimeout(() => {
            if (this.isShuttingDown) return;
            logger.error('gRPC stream silent for 5 minutes — forcing reconnect');
            this.sendAlert('⚠️ FlowLens: gRPC stream silent for 5 minutes — reconnecting');
            try { stream.destroy(); } catch {}
        }, WATCHDOG_MS);
    }

    private clearWatchdog() {
        if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
    }

    private sendAlert(message: string) {
        const url = process.env.DISCORD_WEBHOOK_URL;
        if (!url) return;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message }),
        }).catch(() => {});
    }

    // ─── Reconnect ────────────────────────────────────────────────────────────

    private scheduleReconnect() {
        if (this.isShuttingDown || this.reconnectTimer) return;
        const delay = this.reconnectMs;
        this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
        logger.info({ delaySeconds: Math.round(delay / 1000) }, 'scheduling gRPC reconnect');
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.start(); }, delay);
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    private clearPingInterval() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    }

    // ─── Transaction processing (fully synchronous — no external awaits) ──────

    private handleTransaction(txUpdate: any): void {
        // SubscribeUpdateTransaction → .transaction → SubscribeUpdateTransactionInfo
        const info = txUpdate.transaction;
        if (!info) return;
        const meta = info.meta;
        const tx   = info.transaction;
        if (!meta || !tx) return;
        if (meta.err && Object.keys(meta.err).length > 0) return;

        const sigBytes = info.signature;
        if (!sigBytes) return;
        const signature = bs58.encode(sigBytes);

        const msgKeys = tx.message?.accountKeys;
        if (!msgKeys?.length) return;

        const accountKeys: string[] = msgKeys.map((k: Uint8Array) => {
            try { return new PublicKey(k).toBase58(); } catch { return ''; }
        }).filter(Boolean);

        const feeWallet = accountKeys.find(k => this.walletToPlatform[k]);
        if (!feeWallet) return;
        const platform  = this.walletToPlatform[feeWallet];

        const userPubkey = accountKeys[0];
        if (!userPubkey) return;

        const solDiff   = (Number(meta.postBalances?.[0] || 0) - Number(meta.preBalances?.[0] || 0)) / 1e9;
        const solAmount = Math.abs(solDiff);
        if (solAmount < 0.005) { this.droppedTrades++; return; }

        const tokenDiffs: Record<string, number> = {};
        for (const b of (meta.preTokenBalances || [])) {
            const owner = b.owner || accountKeys[b.accountIndex];
            if (owner === userPubkey)
                tokenDiffs[b.mint] = (tokenDiffs[b.mint] ?? 0) - Number(b.uiTokenAmount?.uiAmount || 0);
        }
        for (const b of (meta.postTokenBalances || [])) {
            const owner = b.owner || accountKeys[b.accountIndex];
            if (owner === userPubkey)
                tokenDiffs[b.mint] = (tokenDiffs[b.mint] ?? 0) + Number(b.uiTokenAmount?.uiAmount || 0);
        }

        let mainMint = '', maxDiff = 0;
        for (const [mint, diff] of Object.entries(tokenDiffs)) {
            if (mint === WSOL) continue;
            if (Math.abs(diff) > Math.abs(maxDiff)) { maxDiff = diff; mainMint = mint; }
        }
        if (!mainMint || maxDiff === 0) { this.droppedTrades++; return; }

        const direction   = maxDiff > 0 ? 'BUY' : 'SELL';
        const tokenAmount = Math.abs(maxDiff);
        const timestamp   = Date.now();

        // Synchronous cache lookup — never blocks on network
        const cachedPrice = TokenPriceService.getCachedPrice(mainMint);
        let usdValue = 0, usdEstimated = 0;
        if (cachedPrice && cachedPrice > 0) {
            usdValue = tokenAmount * cachedPrice;
        } else {
            usdValue     = solAmount * PriceService.getCurrentPrice();
            usdEstimated = 1;
            TokenPriceService.queueForPricing(mainMint);   // background fetch, non-blocking
        }

        // insertEvent.run(signature, timestamp, platform, mainMint, solAmount, direction,
        //     usdValue, usdEstimated, JSON.stringify({ solDiff, tokenDiff: maxDiff }));

        this.txCount++;
        this.onTrade?.({ signature, timestamp, platform, tokenMint: mainMint, solAmount, direction, usdValue });

        logger.info({
            platform, direction, token: mainMint.slice(0, 8),
            sol: solAmount.toFixed(3),
            usd: usdValue.toFixed(2),
            estimated: usdEstimated === 1,
        }, 'trade');
    }
}
