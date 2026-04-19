// Shared types for FlowLens WebSocket and REST API.
// TypeScript clients can import these directly.

export type TimeWindow = '1m' | '5m' | '30m' | '1h' | '24h';

export interface TokenSnapshot {
    mint:              string;
    dominant_platform: string;
    total_volume_sol:  number;
    total_volume_usd:  number;
    net_sol:           number;
    buy_count:         number;
    sell_count:        number;
    first_seen:        number;  // ms epoch of earliest trade in this window
}

// Payload emitted on the `volume-update` event
export interface VolumeUpdatePayload {
    room:      string;   // e.g. "global-volume-1m" — window is encoded in the room name
    timestamp: number;   // ms epoch when snapshot was computed
    tokens:    TokenSnapshot[];
}

// ─── Socket.io typed helpers ──────────────────────────────────────────────────

// Events the CLIENT emits to the server
export interface ClientEmitEvents {
    join:  (rooms: string | string[]) => void;
    leave: (rooms: string | string[]) => void;
}

// Events the SERVER emits to the client
export interface ServerEmitEvents {
    'volume-update': (payload: VolumeUpdatePayload) => void;
    'error':         (payload: { message: string }) => void;
}

// ─── Room naming helpers ──────────────────────────────────────────────────────

export const VALID_WINDOWS: TimeWindow[] = ['1m', '5m', '30m', '1h', '24h'];

export function globalRoom(window: TimeWindow): string {
    return `global-volume-${window}`;
}

export function platformRoom(platform: string, window: TimeWindow): string {
    return `platform-${platform}-${window}`;
}
