import axios from 'axios';

const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';
const CACHE_TTL     = 30  * 1000; // 30s for known prices
const NEGATIVE_TTL  = 300 * 1000; // 5min for unlisted tokens (suppress retry spam)

interface CacheEntry {
    price:     number | null; // null = confirmed unlisted
    timestamp: number;
}

export class TokenPriceService {
    private static cache: Record<string, CacheEntry> = {};

    static async getPrice(mint: string): Promise<number | null> {
        if (!mint) return null;

        const entry = this.cache[mint];
        if (entry) {
            const ttl = entry.price === null ? NEGATIVE_TTL : CACHE_TTL;
            if (Date.now() - entry.timestamp < ttl) {
                return entry.price;
            }
        }

        try {
            const response = await axios.get(`${JUPITER_PRICE_URL}?ids=${mint}`);
            const data = response.data?.data?.[mint];

            if (data?.price) {
                const price = Number(data.price);
                this.cache[mint] = { price, timestamp: Date.now() };
                return price;
            }

            // Jupiter returned data but no price for this mint → treat as unlisted
            this.cache[mint] = { price: null, timestamp: Date.now() };
            return null;
        } catch (err: any) {
            if (err?.response?.status === 404) {
                // Token not listed on Jupiter — cache negatively, no log spam
                this.cache[mint] = { price: null, timestamp: Date.now() };
            } else {
                console.error(`[TokenPriceService] Error fetching price for ${mint}:`, err.message);
            }
            return null;
        }
    }
}
