import { logger } from '../logger.js';

const SOL_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const WSOL        = 'So11111111111111111111111111111111111111112';

const PYTH_ENDPOINTS = [
    'https://hermes.pyth.network',
    'https://hermes-beta.pyth.network',
];
const JUPITER_SOL_URL = `https://api.jup.ag/price/v2?ids=${WSOL}`;

const POLL_MS    = 15_000;
const TIMEOUT_MS = 8_000;

export class PriceService {
    private static currentPrice  = 0;
    private static activeSource  = '';
    private static timer: NodeJS.Timeout | null = null;

    static start() {
        if (this.timer) return;
        void this.poll();
        this.timer = setInterval(() => void this.poll(), POLL_MS);
    }

    private static async poll() {
        for (const base of PYTH_ENDPOINTS) {
            try {
                const url = `${base}/v2/updates/price/latest?ids[]=${SOL_FEED_ID}`;
                const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
                if (!res.ok) continue;
                const data: any = await res.json();
                const feed = data.parsed?.find((f: any) => f.id === SOL_FEED_ID);
                if (!feed?.price?.price) continue;
                const price = Number(feed.price.price) * Math.pow(10, feed.price.expo);
                if (price <= 0) continue;
                if (this.activeSource !== base) {
                    this.activeSource = base;
                    logger.info({ price: price.toFixed(2), source: base.replace('https://', '') }, 'SOL price source');
                }
                this.currentPrice = price;
                return;
            } catch {
                // try next endpoint
            }
        }

        // Pyth unreachable — fall back to Jupiter
        try {
            const res = await fetch(JUPITER_SOL_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (res.ok) {
                const data: any = await res.json();
                const price = Number(data.data?.[WSOL]?.price ?? 0);
                if (price > 0) {
                    if (this.activeSource !== 'jupiter') {
                        this.activeSource = 'jupiter';
                        logger.warn({ price: price.toFixed(2) }, 'SOL price falling back to Jupiter');
                    }
                    this.currentPrice = price;
                    return;
                }
            }
        } catch {
            // keep cached price
        }

        if (this.currentPrice === 0) {
            logger.warn('all SOL price sources unreachable — using $150 hardcoded fallback');
        }
    }

    static getCurrentPrice(): number {
        return this.currentPrice || 150;
    }
}
