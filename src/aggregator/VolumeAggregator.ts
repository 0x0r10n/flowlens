import type { VolumeBroadcaster } from '../websocket/VolumeBroadcaster.js';
import { logger } from '../logger.js';
import type { TokenSnapshot } from '../types.js';
import { redis } from '../redis/client.js';

export interface TradeEvent {
    signature:  string;
    timestamp:  number;
    platform:   string;
    tokenMint:  string;
    solAmount:  number;
    direction:  'BUY' | 'SELL';
    usdValue:   number;
}

const WINDOWS: Record<string, number> = {
    '1m':  1  * 60 * 1_000,
    '5m':  5  * 60 * 1_000,
    '30m': 30 * 60 * 1_000,
    '1h':  60 * 60 * 1_000,
    '24h': 24 * 60 * 60 * 1_000,
};

const TOP_N          = 50;
const BROADCAST_MS   = 1000; // Throttled broadcast

export class VolumeAggregator {
    private dirtyFlags = new Set<string>();

    constructor(private broadcaster: VolumeBroadcaster) {
        setInterval(() => this.flushDirty(), BROADCAST_MS);
    }

    // No longer needing seeding from DB into memory.
    // However, we could seed Redis from DB if it's empty, but the plan says Phase 2.5 is optional.
    seedFromDb() {
        logger.info('Aggregator seeding skipped — redis persists snapshots');
    }

    async ingest(trade: TradeEvent) {
        const pipeline = redis.pipeline();
        const now      = Date.now();

        // 1. Details Hash (Persistent state for the token)
        const detailsKey = `details:${trade.tokenMint}`;
        
        // Use HSETNX for first_seen to avoid overwriting
        pipeline.hsetnx(detailsKey, 'first_seen', trade.timestamp.toString());
        
        // Atomic increments for long-term totals (optional, but good for details)
        pipeline.hincrbyfloat(detailsKey, 'total_volume_sol', trade.solAmount);
        pipeline.hincrbyfloat(detailsKey, 'total_volume_usd', trade.usdValue);
        
        if (trade.direction === 'BUY') {
            pipeline.hincrby(detailsKey, 'buy_count', 1);
            pipeline.hincrbyfloat(detailsKey, 'net_sol', trade.solAmount);
        } else {
            pipeline.hincrby(detailsKey, 'sell_count', 1);
            pipeline.hincrbyfloat(detailsKey, 'net_sol', -trade.solAmount);
        }

        // Calculate dominant platform
        pipeline.hset(detailsKey, 'dominant_platform', trade.platform);
        pipeline.hset(detailsKey, 'last_updated', now.toString());

        // 2. Ranking Sorted Sets
        for (const [win, ms] of Object.entries(WINDOWS)) {
            const globalKey   = `volume:global:${win}`;
            const platformKey = `volume:${trade.platform}:${win}`;
            const expiry      = Math.ceil(ms / 1000) * 2; // TTL 2x window size

            pipeline.zincrby(globalKey, trade.solAmount, trade.tokenMint);
            pipeline.zincrby(platformKey, trade.solAmount, trade.tokenMint);
            
            pipeline.expire(globalKey, expiry);
            pipeline.expire(platformKey, expiry);

            // 3. Platform Stats (for dashboard)
            const statsKey = `stats:${trade.platform}:${win}`;
            pipeline.hincrbyfloat(statsKey, 'net_sol', trade.direction === 'BUY' ? trade.solAmount : -trade.solAmount);
            pipeline.hincrbyfloat(statsKey, 'net_usd', trade.direction === 'BUY' ? trade.usdValue : -trade.usdValue);
            pipeline.hincrby(statsKey, 'trade_count', 1);
            pipeline.expire(statsKey, expiry);

            this.dirtyFlags.add(`global-volume-${win}`);
            this.dirtyFlags.add(`platform-${trade.platform}-${win}`);
        }

        await pipeline.exec();
    }

    allRooms(platforms: string[]): string[] {
        const rooms: string[] = [];
        for (const w of [...Object.keys(WINDOWS), 'overview']) {
            rooms.push(`global-volume-${w}`);
            for (const p of platforms) rooms.push(`platform-${p}-${w}`);
        }
        return rooms;
    }

    private async flushDirty() {
        if (this.dirtyFlags.size === 0) return;
        
        const roomsToProcess = [...this.dirtyFlags];
        this.dirtyFlags.clear();

        const overviewPrefixes = new Set<string>();

        for (const room of roomsToProcess) {
            try {
                const parts    = room.split('-');
                const window   = parts.at(-1)!;
                const isGlobal = room.startsWith('global-');
                const platform = isGlobal ? null : parts.slice(1, -1).join('-');

                if (['1m', '5m', '30m', '1h'].includes(window)) {
                    overviewPrefixes.add(isGlobal ? 'global-volume' : `platform-${platform}`);
                }

                const snapshot = await this.getTopTokens(window, platform);
                const payload  = { room, timestamp: Date.now(), tokens: snapshot };
                
                // Broadcast + Save snapshot to Redis for instant join
                this.broadcaster.broadcast(room, payload);
                await redis.set(`snapshot:${room}`, JSON.stringify(payload), 'EX', 3600);
            } catch (err) {
                logger.error({ room, err }, 'Failed to flush room');
            }
        }

        // Process composite overview rooms
        for (const prefix of overviewPrefixes) {
            try {
                const room = `${prefix}-overview`;
                const isGlobal = prefix === 'global-volume';
                const platform = isGlobal ? null : prefix.replace('platform-', '');

                const [tokens1m, tokens5m, tokens30m, tokens1h] = await Promise.all([
                    this.getTopTokens('1m', platform),
                    this.getTopTokens('5m', platform),
                    this.getTopTokens('30m', platform),
                    this.getTopTokens('1h', platform)
                ]);

                const payload = {
                    room,
                    timestamp: Date.now(),
                    tokens: {
                        '1m': tokens1m,
                        '5m': tokens5m,
                        '30m': tokens30m,
                        '1h': tokens1h
                    }
                };

                this.broadcaster.broadcast(room, payload);
                await redis.set(`snapshot:${room}`, JSON.stringify(payload), 'EX', 3600);
            } catch (err) {
                logger.error({ room: `${prefix}-overview`, err }, 'Failed to flush overview room');
            }
        }
    }

    async getTopTokens(window: string, platform: string | null): Promise<TokenSnapshot[]> {
        const rankingKey = platform ? `volume:${platform}:${window}` : `volume:global:${window}`;
        
        // Get top 50 mints by score (volume)
        const topMints = await redis.zrevrange(rankingKey, 0, TOP_N - 1);
        if (topMints.length === 0) return [];

        const snapshots: TokenSnapshot[] = [];
        const pipeline = redis.pipeline();
        for (const mint of topMints) {
            pipeline.hgetall(`details:${mint}`);
            pipeline.zscore(rankingKey, mint); // Get window-specific volume
        }
        
        const results = await pipeline.exec();
        if (!results) return [];

        for (let i = 0; i < topMints.length; i++) {
            const detailsIdx = i * 2;
            const scoreIdx   = i * 2 + 1;
            
            const [errD, details] = results[detailsIdx] as [Error | null, any];
            const [errS, score]   = results[scoreIdx]   as [Error | null, string | null];

            if (errD || !details || Object.keys(details).length === 0) continue;

            const mint = topMints[i];
            const windowVol = Number(score || 0);

            snapshots.push({
                mint,
                dominant_platform: details.dominant_platform || '',
                total_volume_sol:  windowVol,
                total_volume_usd:  windowVol * 200, // Approximate fallback (can improve later)
                net_sol:           Number(details.net_sol || 0),
                buy_count:         Number(details.buy_count || 0),
                sell_count:        Number(details.sell_count || 0),
                first_seen:        Number(details.first_seen || 0),
            });
        }

        return snapshots;
    }

    async getPlatformStats(platform: string, window: string) {
        const statsKey = `stats:${platform}:${window}`;
        const data     = await redis.hgetall(statsKey);
        
        // Also get top token for this platform/window
        const rankingKey = `volume:${platform}:${window}`;
        const top = await redis.zrevrange(rankingKey, 0, 0, 'WITHSCORES');
        
        return {
            netSol:   Number(data.net_sol || 0),
            netUsd:   Number(data.net_usd || 0),
            trades:   Number(data.trade_count || 0),
            topToken: top[0] || 'N/A',
            topVol:   Number(top[1] || 0)
        };
    }
}
