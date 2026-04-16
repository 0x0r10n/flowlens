import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SyncService } from './SyncService.js';
import { TokenPriceService } from './TokenPriceService.js';
import { PriceService } from './PriceService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const dbPath     = path.join(__dirname, '..', '..', 'flowlens.db');
const cursorsPath = path.join(__dirname, '..', '..', 'cursors.json');
const db = new Database(dbPath);

// Ensure the column exists before preparing the statement — this runs
// before index.ts has a chance to apply its own migration.
try {
    db.prepare(`ALTER TABLE platform_events ADD COLUMN usd_estimated INTEGER NOT NULL DEFAULT 0`).run();
} catch { /* column already exists */ }

const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO platform_events
    (signature, timestamp, platform, token_mint, sol_amount, direction, usd_value, usd_estimated, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── Rate-limit backoff constants ────────────────────────────────────────────
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS  = 120_000;
const RATE_LIMIT_SIGNALS = ['429', 'Too Many Requests', 'rate limit', 'exceeded'];

export class ChainstackPoller {
    private connection: Connection;
    private isRunning = false;
    private lastSignatures: Record<string, string> = {};

    // Per-wallet backoff state
    private cooldownUntil: Record<string, number> = {};
    private backoffMs:     Record<string, number> = {};

    constructor(rpcUrl: string) {
        this.connection = new Connection(rpcUrl, 'confirmed');
        try {
            if (fs.existsSync(cursorsPath)) {
                this.lastSignatures = JSON.parse(fs.readFileSync(cursorsPath, 'utf8'));
                console.log(`📌 Loaded ${Object.keys(this.lastSignatures).length} poll cursors.`);
            }
        } catch {
            console.warn('⚠️  Could not read cursors.json — starting fresh.');
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        const host = new URL(this.connection.rpcEndpoint).hostname;
        console.log(`🔌 Chainstack poller started via ${host}`);
        this.pollLoop();
    }

    private async pollLoop() {
        while (this.isRunning) {
            try {
                const platforms = SyncService.getLocalPlatforms();
                const wallets: { platform: string; pubkey: string }[] = [];

                for (const [platform, addrs] of Object.entries(platforms)) {
                    for (const pubkey of (addrs as string[]).slice(0, 5)) {
                        wallets.push({ platform, pubkey });
                    }
                }

                for (const { platform, pubkey } of wallets) {
                    if (this.isOnCooldown(pubkey)) continue;
                    await this.pollWallet(platform, pubkey);
                    await sleep(200);
                }
            } catch (err) {
                console.error('❌ [Poller] loop error:', (err as Error).message);
            }
            await sleep(5_000);
        }
    }

    // ─── Per-wallet poll ──────────────────────────────────────────────────────

    private async pollWallet(platform: string, pubkey: string) {
        try {
            const opts: any = { limit: 15 };
            const lastSig = this.lastSignatures[pubkey];
            if (lastSig) opts.until = lastSig;

            const signatures = await this.connection.getSignaturesForAddress(new PublicKey(pubkey), opts);
            if (signatures.length === 0) return;

            this.lastSignatures[pubkey] = signatures[0].signature;
            this.saveCursors();
            this.clearBackoff(pubkey);

            const parsedTxs = await this.fetchParsedTxs(signatures.map(s => s.signature));
            if (!parsedTxs) return;

            for (let i = 0; i < parsedTxs.length; i++) {
                const tx  = parsedTxs[i];
                const sig = signatures[i].signature;
                if (!tx || tx.meta?.err) continue;
                await this.processTx(platform, pubkey, sig, tx);
            }
        } catch (err) {
            const msg = (err as Error).message;
            if (isRateLimited(msg)) {
                this.applyBackoff(pubkey);
            } else if (!msg.includes('fetch failed')) {
                console.error(`[Poller] wallet ${pubkey.slice(0, 6)}:`, msg);
            }
        }
    }

    // ─── Fetch with retry ─────────────────────────────────────────────────────

    private async fetchParsedTxs(
        sigs: string[],
        retries = 2
    ): Promise<(ParsedTransactionWithMeta | null)[] | null> {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await this.connection.getParsedTransactions(sigs, {
                    maxSupportedTransactionVersion: 0,
                });
            } catch (err) {
                const msg = (err as Error).message;
                if (isRateLimited(msg)) throw err; // let pollWallet handle backoff
                if (attempt === retries) {
                    console.error(`[Poller] getParsedTransactions failed after ${retries + 1} attempts:`, msg);
                    return null;
                }
                await sleep(1_000 * (attempt + 1));
            }
        }
        return null;
    }

    // ─── Swap parsing ─────────────────────────────────────────────────────────

    private async processTx(
        platform: string,
        feeWallet: string,
        signature: string,
        tx: ParsedTransactionWithMeta
    ) {
        const meta = tx.meta;
        if (!meta) return;

        // Account at index 0 is the fee payer / signer in standard Solana txs
        const accountKeys = tx.transaction.message.accountKeys;
        const firstKey = accountKeys[0];
        const userPubkey: string =
            typeof firstKey === 'string'
                ? firstKey
                : (firstKey as any)?.pubkey?.toString?.() ?? '';

        if (!userPubkey) {
            console.debug(`[Parser] ${signature.slice(0, 8)}: could not resolve user pubkey — skipped`);
            return;
        }

        // ── SOL balance change for user (index 0) ──────────────────────────
        const preSol  = meta.preBalances[0]  ?? 0;
        const postSol = meta.postBalances[0] ?? 0;
        const solDiff = (postSol - preSol) / 1e9;

        // ── Token balance changes attributed to the user ───────────────────
        const preToken  = (meta.preTokenBalances  ?? []).filter(b => b.owner === userPubkey);
        const postToken = (meta.postTokenBalances ?? []).filter(b => b.owner === userPubkey);

        const tokenDiffs: Record<string, number> = {};
        for (const b of preToken) {
            tokenDiffs[b.mint] = (tokenDiffs[b.mint] ?? 0) - Number(b.uiTokenAmount.uiAmount ?? 0);
        }
        for (const b of postToken) {
            tokenDiffs[b.mint] = (tokenDiffs[b.mint] ?? 0) + Number(b.uiTokenAmount.uiAmount ?? 0);
        }

        // ── Find primary token (largest absolute change; ignore wSOL) ──────
        const WSOL = 'So11111111111111111111111111111111111111112';
        let mainMint = '';
        let maxDiff  = 0;
        for (const [mint, diff] of Object.entries(tokenDiffs)) {
            if (mint === WSOL) continue;
            if (Math.abs(diff) > Math.abs(maxDiff)) {
                maxDiff  = diff;
                mainMint = mint;
            }
        }

        if (!mainMint || maxDiff === 0) {
            console.debug(`[Parser] ${signature.slice(0, 8)}: no SPL token change found — skipped`);
            return;
        }

        // ── Derive direction ───────────────────────────────────────────────
        // maxDiff > 0 means user gained the token → BUY; lost → SELL
        const direction = maxDiff > 0 ? 'BUY' : 'SELL';
        const solAmount = Math.abs(solDiff);
        const tokenAmount = Math.abs(maxDiff);
        const timestamp = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;

        // Ignore dust trades
        if (solAmount < 0.005) {
            console.debug(`[Parser] ${signature.slice(0, 8)}: dust (${solAmount.toFixed(4)} SOL) — skipped`);
            return;
        }

        // ── Valuation ─────────────────────────────────────────────────────
        let usdValue      = 0;
        let usdEstimated  = 0; // 0 = token price, 1 = estimated from SOL

        const tokenPrice = await TokenPriceService.getPrice(mainMint);
        if (tokenPrice && tokenPrice > 0) {
            usdValue = tokenAmount * tokenPrice;
        } else {
            // Fallback: approximate from SOL amount × current SOL/USD
            usdValue     = solAmount * PriceService.getCurrentPrice();
            usdEstimated = 1;
        }

        // ── Persist ───────────────────────────────────────────────────────
        try {
            insertEvent.run(
                signature,
                timestamp,
                platform,
                mainMint,
                solAmount,
                direction,
                usdValue,
                usdEstimated,
                JSON.stringify({ solDiff, tokenDiff: maxDiff })
            );
            const priceTag = usdEstimated ? '~$' : '$';
            console.log(
                `✅ [${platform}] ${direction} ${mainMint.slice(0, 8)}…` +
                ` | ${solAmount.toFixed(3)} SOL (${priceTag}${usdValue.toFixed(2)})`
            );
        } catch (e: any) {
            if (!e.message.includes('UNIQUE constraint failed')) {
                console.error('[DB] Insert error:', e.message);
            }
        }
    }

    // ─── Backoff helpers ──────────────────────────────────────────────────────

    private isOnCooldown(pubkey: string): boolean {
        return Date.now() < (this.cooldownUntil[pubkey] ?? 0);
    }

    private applyBackoff(pubkey: string) {
        const current = this.backoffMs[pubkey] ?? BACKOFF_BASE_MS;
        const next    = Math.min(current * 2, BACKOFF_MAX_MS);
        this.backoffMs[pubkey]     = next;
        this.cooldownUntil[pubkey] = Date.now() + next;
        console.warn(`⏳ [${pubkey.slice(0, 6)}…] rate limited — cooldown ${(next / 1000).toFixed(0)}s`);
    }

    private clearBackoff(pubkey: string) {
        this.backoffMs[pubkey] = BACKOFF_BASE_MS;
    }

    // ─── Cursor persistence ───────────────────────────────────────────────────

    private saveCursors() {
        try {
            fs.writeFileSync(cursorsPath, JSON.stringify(this.lastSignatures));
        } catch (err) {
            console.error('[Poller] cursor save failed:', (err as Error).message);
        }
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms));
}

function isRateLimited(msg: string): boolean {
    return RATE_LIMIT_SIGNALS.some(s => msg.includes(s));
}
