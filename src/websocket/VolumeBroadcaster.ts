import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { logger } from '../logger.js';
import type { ClientEmitEvents, ServerEmitEvents } from '../types.js';

const PORT = parseInt(process.env.PORT || '3001');

const VALID_ROOM = /^(global-volume|platform-[\w-]+)-(1m|5m|30m|1h|24h|overview)$/;

export class VolumeBroadcaster {
    readonly io: SocketServer<ClientEmitEvents, ServerEmitEvents>;
    private snapshots = new Map<string, any>();
    private redis: any = null;
    private connected = false;

    constructor(httpServer: HttpServer) {
        // Allow specific origins via CORS_ORIGINS env var (comma-separated).
        // Falls back to '*' so local dev works without configuration.
        const rawOrigins = process.env.CORS_ORIGINS;
        const corsOrigin = rawOrigins
            ? rawOrigins.split(',').map(s => s.trim())
            : '*';

        this.io = new SocketServer(httpServer, {
            cors:         { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
            transports:   ['websocket', 'polling'],
            pingInterval: 25_000,
            pingTimeout:  60_000,
            path:         '/socket.io',
        });

        this.io.on('connection', (socket) => {
            logger.info({ id: socket.id }, 'WS client connected');

            socket.on('join', async (rooms) => {
                const list = Array.isArray(rooms) ? rooms : [rooms];
                const valid = list.filter(r => VALID_ROOM.test(r));

                if (valid.length !== list.length) {
                    const invalid = list.filter(r => !VALID_ROOM.test(r));
                    socket.emit('error', { message: `invalid room(s): ${invalid.join(', ')}` });
                }

                for (const room of valid) {
                    socket.join(room);
                    
                    // 1. Try local memory cache
                    let snapshot = this.snapshots.get(room);
                    
                    // 2. Fallback to Redis if memory is empty
                    if (!snapshot && this.redis) {
                        try {
                            const raw = await this.redis.get(`snapshot:${room}`);
                            if (raw) {
                                snapshot = JSON.parse(raw);
                                this.snapshots.set(room, snapshot); // cache it locally
                            }
                        } catch { /* skip */ }
                    }

                    if (snapshot) socket.emit('volume-update', snapshot);
                }

                if (valid.length > 0) logger.info({ id: socket.id, rooms: valid }, 'WS join');
            });

            socket.on('leave', (rooms) => {
                const list = Array.isArray(rooms) ? rooms : [rooms];
                for (const room of list) socket.leave(room);
            });

            socket.on('disconnect', () => {
                logger.info({ id: socket.id }, 'WS client disconnected');
            });
        });
    }

    async connectRedis(redisUrl: string) {
        try {
            const [{ createAdapter }, { Redis }] = await Promise.all([
                import('@socket.io/redis-adapter'),
                import('ioredis'),
            ]);

            const pub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
            const sub = pub.duplicate();

            await Promise.all([pub.connect(), sub.connect()]);

            this.io.adapter(createAdapter(pub, sub));
            this.redis = pub;
            this.connected = true;
            logger.info('Redis adapter active — horizontal scaling ready');
        } catch (err) {
            logger.warn({ err: (err as Error).message }, 'Redis unavailable, using in-memory adapter');
        }
    }

    broadcast(room: string, data: any) {
        this.snapshots.set(room, data);
        this.io.to(room).emit('volume-update', data);

        if (this.redis && this.connected) {
            this.redis.set(`snapshot:${room}`, JSON.stringify(data), 'EX', 3600).catch(() => {});
        }
    }

    async restoreSnapshots(rooms: string[]) {
        if (!this.redis) return;
        for (const room of rooms) {
            try {
                const raw = await this.redis.get(`snapshot:${room}`);
                if (raw) this.snapshots.set(room, JSON.parse(raw));
            } catch { /* skip */ }
        }
    }

    getAvailableRooms(): string[] {
        return [...this.snapshots.keys()];
    }
}
