import { EventSource } from 'eventsource';

const SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const HERMES_SSE_URL = `https://hermes.pyth.network/v2/updates/price/stream?ids[]=${SOL_USD_FEED_ID}`;

export class PriceService {
    private static currentPrice: number = 0;
    private static eventSource: EventSource | null = null;

    static start() {
        if (this.eventSource) return;

        console.log('🔌 Connecting to Pyth Hermes for live SOL/USD price...');
        
        this.eventSource = new EventSource(HERMES_SSE_URL);

        this.eventSource.onmessage = (event: any) => {
            try {
                const data = JSON.parse(event.data);
                const solFeed = data.parsed?.find((f: any) => f.id === SOL_USD_FEED_ID);

                if (solFeed) {
                    this.currentPrice = Number(solFeed.price.price) * Math.pow(10, solFeed.price.expo);
                }
            } catch (err) {
                console.error('[PriceService] Error parsing price data:', err);
            }
        };

        this.eventSource.onerror = (err: any) => {
            console.error('[PriceService] SSE Error:', err);
            this.reconnect();
        };
    }

    private static reconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        setTimeout(() => this.start(), 5000); // Reconnect after 5 seconds
    }

    static getCurrentPrice(): number {
        return this.currentPrice || 150; // Fallback to 150
    }
}
