'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Zap,
  RefreshCcw,
  BarChart3,
  ChevronDown,
  ArrowUpDown,
} from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────────────────

type TimeWindow = '1m' | '5m' | '30m' | '1h' | '24h';
type SortMode = 'net' | 'volume' | 'newest';

interface TokenRow {
  token_mint: string;
  platform: string;
  buy_sol: number;
  sell_sol: number;
  net_sol: number;
  net_usd: number;
  total_sol: number;
  total_volume_usd: number;
  dominant_platform?: string; // only present when platform=all
  trade_count: number;
  buy_count: number;
  sell_count: number;
  first_seen: number;
  usd_estimated: number; // 1 = fallback from SOL price, 0 = real token price
}

interface TokensResponse {
  timestamp: number;
  window: TimeWindow;
  platform: string;
  solPrice: number;
  tokens: TokenRow[];
}

interface PlatformVolume {
  netSol: number;
  netUsd: number;
  trades: number;
}

interface PlatformData {
  volumes: Record<TimeWindow, PlatformVolume>;
  topToken: string;
  topTokenVolume: number;
}

interface DashboardResponse {
  timestamp: number;
  solPrice: number;
  platforms: Record<string, PlatformData>;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = '/api';
const WINDOWS: TimeWindow[] = ['1m', '5m', '30m', '1h', '24h'];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function shortMint(mint: string): string {
  if (!mint || mint === 'N/A') return '—';
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function fmtSol(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(2);
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${Math.abs(v).toFixed(0)}`;
}

function fmtAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

// ─── Copy Mint ─────────────────────────────────────────────────────────────────

function CopyMint({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(mint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      onClick={handleCopy}
      title={mint}
      className="flex items-center gap-1.5 font-mono text-xs text-zinc-300 hover:text-white transition-colors cursor-copy"
    >
      {shortMint(mint)}
      <span className={`text-[10px] transition-colors ${copied ? 'text-emerald-400' : 'text-zinc-600'}`}>
        {copied ? '✓' : '⎘'}
      </span>
    </button>
  );
}

// ─── Buy/Sell Bar ───────────────────────────────────────────────────────────────

function BuySellBar({ buySol, sellSol }: { buySol: number; sellSol: number }) {
  const total = buySol + sellSol;
  if (total === 0) return <div className="w-24 h-1.5 rounded-full bg-zinc-800" />;
  const buyPct = (buySol / total) * 100;
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-20 h-1.5 rounded-full bg-zinc-800 overflow-hidden flex">
        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${buyPct}%` }} />
      </div>
      <span className="text-[10px] text-zinc-500 tabular-nums w-8">{buyPct.toFixed(0)}%</span>
    </div>
  );
}

// ─── Platform badge ─────────────────────────────────────────────────────────────

const PLATFORM_COLORS: Record<string, string> = {
  axiom:        'bg-blue-500/10 text-blue-400',
  bullx:        'bg-orange-500/10 text-orange-400',
  gmgn:         'bg-purple-500/10 text-purple-400',
  photon:       'bg-yellow-500/10 text-yellow-400',
  trojan:       'bg-red-500/10 text-red-400',
  'lab-terminal': 'bg-cyan-500/10 text-cyan-400',
  'banana-gun': 'bg-yellow-400/10 text-yellow-300',
  maestro:      'bg-pink-500/10 text-pink-400',
  bloom:        'bg-teal-500/10 text-teal-400',
  pepeboost:    'bg-green-500/10 text-green-400',
  nova:         'bg-indigo-500/10 text-indigo-400',
  'vector-bot': 'bg-rose-500/10 text-rose-400',
};

function PlatformBadge({ name }: { name: string }) {
  const cls = PLATFORM_COLORS[name] ?? 'bg-zinc-800 text-zinc-400';
  return (
    <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {name}
    </span>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [tokensData, setTokensData]   = useState<TokensResponse | null>(null);
  const [dashboard,  setDashboard]    = useState<DashboardResponse | null>(null);
  const [platforms,  setPlatforms]    = useState<string[]>([]);
  const [timeWindow, setTimeWindow]   = useState<TimeWindow>('1h');
  const [platform,   setPlatform]     = useState<string>('all');
  const [sortBy,     setSortBy]       = useState<SortMode>('volume');
  const [loading,    setLoading]      = useState(true);
  const [pfOpen,     setPfOpen]       = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [tokRes, dashRes, pfRes] = await Promise.all([
        fetch(`${API_BASE}/tokens?window=${timeWindow}&platform=${platform}&limit=50&sort=${sortBy}`),
        fetch(`${API_BASE}/dashboard`),
        platforms.length === 0 ? fetch(`${API_BASE}/platforms`) : Promise.resolve(null),
      ]);

      if (tokRes.ok)  setTokensData(await tokRes.json());
      if (dashRes.ok) setDashboard(await dashRes.json());
      if (pfRes?.ok) {
        const pf = await pfRes.json();
        setPlatforms(['all', ...(pf.platforms ?? [])]);
      }
      setLoading(false);
    } catch (err) {
      console.error('Fetch error:', err);
    }
  }, [timeWindow, platform, sortBy, platforms.length]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 5000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const solPrice = tokensData?.solPrice ?? dashboard?.solPrice ?? 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 2, ease: 'linear' }}
        >
          <RefreshCcw className="w-10 h-10 text-emerald-400" />
        </motion.div>
      </div>
    );
  }

  const tokens = tokensData?.tokens ?? [];

  return (
    <main className="min-h-screen bg-[#050505] text-white p-4 md:p-8">

      {/* ── Header ── */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div className="flex items-center gap-3">
          <Zap className="w-7 h-7 text-emerald-400 fill-emerald-400/20" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">FlowLens</h1>
            <p className="text-xs text-zinc-500">Real-time Cross-Platform Solana Money Flow</p>
          </div>
        </div>

        <div className="flex items-center gap-6 bg-zinc-900/60 border border-zinc-800 rounded-xl px-5 py-3">
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest">SOL Price</p>
            <p className="text-lg font-mono font-bold text-emerald-400">${solPrice.toFixed(2)}</p>
          </div>
          <div className="h-8 w-px bg-zinc-800" />
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs font-semibold">Live</span>
          </div>
        </div>
      </header>

      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Time window tabs */}
        <div className="flex gap-1 p-1 bg-zinc-900/50 rounded-xl border border-zinc-800">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setTimeWindow(w)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                timeWindow === w
                  ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/20'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
              }`}
            >
              {w.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Platform filter */}
        <div className="relative">
          <button
            onClick={() => setPfOpen(o => !o)}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-900/50 border border-zinc-800 rounded-xl text-xs font-semibold hover:bg-zinc-800 transition-colors"
          >
            <BarChart3 className="w-3.5 h-3.5 text-zinc-400" />
            {platform === 'all' ? 'All Platforms' : platform}
            <ChevronDown className={`w-3 h-3 text-zinc-500 transition-transform ${pfOpen ? 'rotate-180' : ''}`} />
          </button>

          <AnimatePresence>
            {pfOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute top-full mt-1 left-0 z-50 bg-zinc-900 border border-zinc-800 rounded-xl p-1 min-w-[160px] shadow-xl"
              >
                {platforms.map((p) => (
                  <button
                    key={p}
                    onClick={() => { setPlatform(p); setPfOpen(false); }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                      platform === p
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                    }`}
                  >
                    {p === 'all' ? 'All Platforms' : p}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Sort toggle */}
        <button
          onClick={() => setSortBy(s => s === 'volume' ? 'net' : s === 'net' ? 'newest' : 'volume')}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-900/50 border border-zinc-800 rounded-xl text-xs font-semibold hover:bg-zinc-800 transition-colors"
        >
          <ArrowUpDown className="w-3.5 h-3.5 text-zinc-400" />
          Sort: {sortBy === 'volume' ? 'Total Volume' : sortBy === 'net' ? 'Net Flow' : 'Newest'}
        </button>

        <span className="ml-auto text-[10px] text-zinc-600 flex items-center gap-1">
          <Activity className="w-3 h-3" /> live · 5s refresh
          {tokensData && (
            <span className="ml-2 text-zinc-700">· updated {fmtAge(tokensData.timestamp)}</span>
          )}
        </span>
      </div>

      {/* ── Hot Tokens Table ── */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            {platform === 'all' ? 'Global Volume Leaders' : `Most Traded on ${platform}`}
            <span className="text-xs font-normal text-zinc-500 ml-1">
              {tokens.length} results · {timeWindow.toUpperCase()} window
            </span>
          </h2>
        </div>

        <div className="rounded-2xl border border-zinc-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-900/80 text-[10px] uppercase tracking-widest text-zinc-500">
                  <th className="px-4 py-3 text-left w-8">#</th>
                  <th className="px-4 py-3 text-left">Token</th>
                  <th className="px-4 py-3 text-left">{platform === 'all' ? 'Top Platform' : 'Platform'}</th>
                  <th className="px-4 py-3 text-right">Volume (SOL)</th>
                  <th className="px-4 py-3 text-right">Volume (USD)</th>
                  <th className="px-4 py-3 text-right">Net Flow</th>
                  <th className="px-4 py-3 text-left">Buy %</th>
                  <th className="px-4 py-3 text-right">Trades</th>
                  {sortBy === 'newest' && <th className="px-4 py-3 text-right">First Seen</th>}
                </tr>
              </thead>
              <tbody>
                {tokens.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-zinc-600 text-sm">
                      No data yet — waiting for transactions to be ingested...
                    </td>
                  </tr>
                ) : (
                  tokens.map((token, i) => {
                    const isPositive = token.net_sol >= 0;
                    return (
                      <motion.tr
                        key={`${token.token_mint}-${token.dominant_platform ?? token.platform ?? 'all'}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: Math.min(i * 0.02, 0.5) }}
                        className="border-t border-zinc-800/50 hover:bg-zinc-800/30 transition-colors group"
                      >
                        <td className="px-4 py-3 text-zinc-600 font-mono text-xs">{i + 1}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isPositive ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                            <CopyMint mint={token.token_mint} />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <PlatformBadge name={token.dominant_platform ?? token.platform} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="font-mono font-bold text-base text-white tabular-nums">
                            {fmtSol(token.total_sol)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="font-mono text-xs text-zinc-300">
                            {fmtUsd(token.total_volume_usd)}
                          </span>
                          {token.usd_estimated === 1 && (
                            <span
                              title="USD estimated from SOL price — token price unavailable"
                              className="ml-1 text-[9px] text-zinc-600 cursor-help"
                            >
                              est.
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className={`font-mono text-xs ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {isPositive ? '+' : ''}{fmtSol(token.net_sol)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <BuySellBar buySol={token.buy_sol} sellSol={token.sell_sol} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-zinc-500 text-xs font-mono">
                            {token.buy_count}B / {token.sell_count}S
                          </span>
                        </td>
                        {sortBy === 'newest' && (
                          <td className="px-4 py-3 text-right">
                            <span className="text-zinc-600 text-xs font-mono">
                              {fmtAge(token.first_seen)}
                            </span>
                          </td>
                        )}
                      </motion.tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

<footer className="mt-16 text-center text-zinc-700 text-xs">
        <p>&copy; 2026 FlowLens. Powered by Chainstack · Pyth · Jupiter</p>
      </footer>
    </main>
  );
}
