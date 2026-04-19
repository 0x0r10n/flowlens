import { logger } from '../logger.js';

const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';
const CACHE_TTL      = 30  * 1_000;
const NEGATIVE_TTL   = 300 * 1_000;
const BATCH_SIZE     = 100;
const BATCH_INTERVAL = 5_000;
const FETCH_TIMEOUT  = 8_000;

// Circuit breaker: after this many consecutive fetch failures, back off
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_BACKOFF_MS = 60_000;

interface CacheEntry {
    price:     number | null;
    timestamp: number;
}

export class TokenPriceService {
    private static cache:        Record<string, CacheEntry> = {};
    private static priceQueue    = new Set<string>();
    private static timer:        NodeJS.Timeout | null = null;
    private static failureCount  = 0;
    private static backoffUntil  = 0;

    // ── Sync (hot-path) ──────────────────────────────────────────────────────

    static getCachedPrice(mint: string): number | null {
        const entry = this.cache[mint];
        if (!entry) return null;
        const ttl = entry.price === null ? NEGATIVE_TTL : CACHE_TTL;
        if (Date.now() - entry.timestamp >= ttl) return null;
        return entry.price;
    }

    static queueForPricing(mint: string): void {
        if (!this.cache[mint]) this.priceQueue.add(mint);
    }

    // ── Background pricer ────────────────────────────────────────────────────

    static startBackgroundPricer(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.drainQueue(), BATCH_INTERVAL);
    }

    private static async drainQueue(): Promise<void> {
        if (this.priceQueue.size === 0) return;

        // Circuit open — skip until backoff expires
        if (Date.now() < this.backoffUntil) return;

        const mints = [...this.priceQueue].slice(0, BATCH_SIZE);
        mints.forEach(m => this.priceQueue.delete(m));

        try {
            const res = await fetch(
                `${JUPITER_PRICE_URL}?ids=${mints.join(',')}`,
                { signal: AbortSignal.timeout(FETCH_TIMEOUT) }
            );

            if (!res.ok) {
                this.onFetchFailure(mints, `HTTP ${res.status}`);
                return;
            }

            const data: any = await res.json();
            let hits = 0;

            for (const mint of mints) {
                const price = data.data?.[mint]?.price;
                if (price) {
                    this.cache[mint] = { price: Number(price), timestamp: Date.now() };
                    hits++;
                } else {
                    this.cache[mint] = { price: null, timestamp: Date.now() };
                }
            }

            // Success — reset failure streak
            this.failureCount = 0;
            if (hits > 0) logger.debug({ mints: mints.length, hits }, 'background price batch');

        } catch (err: any) {
            this.onFetchFailure(mints, err.message);
        }
    }

    private static onFetchFailure(mints: string[], reason: string): void {
        mints.forEach(m => this.priceQueue.add(m));
        this.failureCount++;

        if (this.failureCount >= CIRCUIT_THRESHOLD) {
            this.backoffUntil = Date.now() + CIRCUIT_BACKOFF_MS;
            this.failureCount = 0;
            logger.warn({ reason, backoffSec: CIRCUIT_BACKOFF_MS / 1000 },
                'Jupiter price circuit open — backing off');
        } else {
            logger.warn({ reason, failures: this.failureCount }, 'background pricer fetch failed');
        }
    }

    // ── Async (legacy, used by ChainstackPoller) ─────────────────────────────

    static async getPrice(mint: string): Promise<number | null> {
        const cached = this.getCachedPrice(mint);
        if (cached !== null) return cached;

        try {
            const res = await fetch(
                `${JUPITER_PRICE_URL}?ids=${mint}`,
                { signal: AbortSignal.timeout(FETCH_TIMEOUT) }
            );
            const data: any = await res.json();
            const price = data.data?.[mint]?.price;

            if (price) {
                this.cache[mint] = { price: Number(price), timestamp: Date.now() };
                return Number(price);
            }
            this.cache[mint] = { price: null, timestamp: Date.now() };
            return null;
        } catch (err: any) {
            if (!err?.message?.includes('404')) {
                logger.warn({ mint, err: err.message }, 'token price fetch failed');
            }
            return null;
        }
    }

    static getCircuitStatus() {
        const backoffRemaining = Math.max(0, this.backoffUntil - Date.now());
        return {
            circuitOpen:      backoffRemaining > 0,
            backoffRemainingMs: backoffRemaining,
            queueSize:        this.priceQueue.size,
            cacheSize:        Object.keys(this.cache).length,
        };
    }
}
