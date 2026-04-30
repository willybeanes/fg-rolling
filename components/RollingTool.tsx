'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from 'recharts';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FgPlayer {
  playerid: string;
  name: string;
  mlbamid: number | null;
  gameLogType: number; // 0=hitter, 1=pitcher
  searchType: 'h' | 'p';
  team?: string;
  pos?: string;
}

interface SelectedPlayer extends FgPlayer {
  color: string;
  rolling: (number | null)[];
  windowStarts: number[];
  gameDates: string[];
  gameVals: (number | null)[];
  lastValidIndex: number;
  totalGames: number;
  headshotUrl: string | null;
}

interface GameLog {
  Date?: string;
  date?: string;
  [key: string]: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Colorblind-friendly palette (Wong) — saturated enough for white background
const PLAYER_COLORS = ['#0072B2', '#E69F00', '#CC79A7', '#009E73', '#56B4E9'];

// weightField: the per-game denominator used to PA/IP-weight the rolling average,
// matching FanGraphs' approach (games with more PAs or IP count proportionally more).
// 'PA' = plate appearances (hitters), 'IP' = innings pitched, 'BF' = batters faced.
const METRICS = [
  { label: 'wOBA',  field: 'wOBA',  category: 'hit',  isPercent: false, decimals: 3, avg: 0.312, weightField: 'PA' },
  { label: 'wRC+',  field: 'wRC+',  category: 'hit',  isPercent: false, decimals: 0, avg: 100,   weightField: 'PA' },
  { label: 'OBP',   field: 'OBP',   category: 'hit',  isPercent: false, decimals: 3, avg: 0.319, weightField: 'PA' },
  { label: 'SLG',   field: 'SLG',   category: 'hit',  isPercent: false, decimals: 3, avg: 0.411, weightField: 'PA' },
  { label: 'BABIP', field: 'BABIP', category: 'hit',  isPercent: false, decimals: 3, avg: 0.296, weightField: 'PA' },
  { label: 'K%',    field: 'K%',    category: 'both', isPercent: true,  decimals: 1, avg: 0.225, weightField: 'PA' },
  { label: 'BB%',   field: 'BB%',   category: 'both', isPercent: true,  decimals: 1, avg: 0.085, weightField: 'PA' },
  { label: 'ERA',   field: 'ERA',   category: 'pit',  isPercent: false, decimals: 2, avg: 4.2,   weightField: 'IP' },
  { label: 'FIP',   field: 'FIP',   category: 'pit',  isPercent: false, decimals: 2, avg: 4.1,   weightField: 'IP' },
  { label: 'xFIP',  field: 'xFIP',  category: 'pit',  isPercent: false, decimals: 2, avg: 4.1,   weightField: 'IP' },
  { label: 'WHIP',  field: 'WHIP',  category: 'pit',  isPercent: false, decimals: 2, avg: 1.28,  weightField: 'IP' },
  { label: 'K-BB%', field: 'K-BB%', category: 'pit',  isPercent: true,  decimals: 1, avg: 0.145, weightField: 'BF' },
] as const;

type MetricLabel = typeof METRICS[number]['label'];

const WINDOW_MIN = 2;
const WINDOW_MAX = 500;
const SEASONS = [2026, 2025, 2024, 2023] as const;

// ─── Utilities ───────────────────────────────────────────────────────────────

function getMetric(label: MetricLabel) {
  return METRICS.find(m => m.label === label)!;
}

function parseVal(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '' || raw === '-') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return isNaN(n) ? null : n;
}

// Parse innings-pitched in baseball notation ("5.2" = 5⅔ innings = 5.667)
function parseIP(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '' || raw === '-') return null;
  const n = parseFloat(String(raw));
  if (isNaN(n)) return null;
  const whole = Math.floor(n);
  const outs = Math.round((n - whole) * 10); // 0, 1, or 2
  return whole + outs / 3;
}

// PA/IP-weighted rolling average matching FanGraphs' approach.
// Walks backwards collecting up to `window` games that have both a valid
// metric value AND a positive weight (PA or IP > 0). Returns rolling values
// and the game index where each window starts (for tooltip date ranges).
function computeRolling(
  vals: (number | null)[],
  weights: (number | null)[],  // PA, IP, or BF per game
  window: number,
): { rolling: (number | null)[]; windowStarts: number[] } {
  const rolling: (number | null)[] = [];
  const windowStarts: number[] = [];

  for (let i = 0; i < vals.length; i++) {
    let sumVW = 0, sumW = 0, count = 0, startIdx = i;
    for (let j = i; j >= 0 && count < window; j--) {
      const v = vals[j];
      const w = weights[j];
      if (v !== null && v !== undefined && w !== null && w !== undefined && w > 0) {
        sumVW += v * w;
        sumW  += w;
        count++;
        startIdx = j;
      }
    }
    if (count === 0) {
      rolling.push(null);
      windowStarts.push(i);
    } else {
      rolling.push(sumVW / sumW);
      windowStarts.push(startIdx);
    }
  }

  return { rolling, windowStarts };
}

function formatVal(val: number, metric: typeof METRICS[number]): string {
  if (metric.isPercent) {
    // FG stores K%/BB% as fractions (0.25 = 25%), display as percentage
    const display = val <= 1.5 ? val * 100 : val;
    return `${display.toFixed(metric.decimals)}%`;
  }
  return val.toFixed(metric.decimals);
}

// Strip HTML tags from FanGraphs date strings like <a href="...">2026-04-28</a>
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

// Format ISO date "2026-04-29" → "Apr 29" (no UTC-shift risk)
function formatDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length < 3) return iso;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  return `${months[m - 1]} ${d}`;
}

// Pick tick dates spaced at least minDays apart so the X-axis isn't overcrowded
function pickTicks(dates: string[], minDays = 7): string[] {
  const ticks: string[] = [];
  let lastMs = -Infinity;
  for (const d of dates) {
    const ms = new Date(d).getTime();
    if (ms - lastMs >= minDays * 86_400_000) {
      ticks.push(d);
      lastMs = ms;
    }
  }
  // Always include the last date
  if (dates.length > 0 && ticks[ticks.length - 1] !== dates[dates.length - 1]) {
    ticks.push(dates[dates.length - 1]);
  }
  return ticks;
}

function headshotUrl(mlbamid: number | null): string | null {
  if (!mlbamid) return null;
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${mlbamid}/headshot/67/current`;
}

// ─── URL state helpers ────────────────────────────────────────────────────────

function decodePlayerParam(s: string, color: string): SelectedPlayer | null {
  // Format: "{fgId}|{mlbamid}|{searchType}|{encodedName}"
  const parts = s.split('|');
  if (parts.length < 4) return null;
  const [playerid, mlbamidStr, searchType, encodedName] = parts;
  if (!playerid || (searchType !== 'h' && searchType !== 'p')) return null;
  const mlbamid = mlbamidStr ? parseInt(mlbamidStr) || null : null;
  const name = decodeURIComponent(encodedName);
  return {
    playerid,
    name,
    mlbamid,
    gameLogType: searchType === 'p' ? 1 : 0,
    searchType,
    team: '',
    pos: '',
    color,
    rolling: [],
    windowStarts: [],
    gameDates: [],
    gameVals: [],
    lastValidIndex: -1,
    totalGames: 0,
    headshotUrl: headshotUrl(mlbamid),
  };
}

function parseUrlState() {
  if (typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search);

  const tab = p.get('tab');
  const playerType: 'hit' | 'pit' = tab === 'pit' ? 'pit' : 'hit';

  const metricParam = p.get('metric') as MetricLabel | null;
  const metric: MetricLabel = metricParam && METRICS.find(m => m.label === metricParam)
    ? metricParam
    : playerType === 'hit' ? 'wOBA' : 'ERA';

  const windowParam = parseInt(p.get('window') ?? '');
  const rollingWindow: number = (windowParam >= WINDOW_MIN && windowParam <= WINDOW_MAX) ? windowParam : 15;

  const seasonParam = parseInt(p.get('season') ?? '');
  const season: number = (SEASONS as readonly number[]).includes(seasonParam) ? seasonParam : 2026;

  const players: SelectedPlayer[] = [];
  for (const encoded of p.getAll('p').slice(0, 5)) {
    const color = PLAYER_COLORS[players.length % PLAYER_COLORS.length];
    const player = decodePlayerParam(encoded, color);
    if (player) players.push(player);
  }

  return { playerType, metric, rollingWindow, season, players };
}

// ─── Player Search Component ──────────────────────────────────────────────────

function PlayerSearch({
  onSelect,
  disabled,
  playerTypeFilter,
  season,
  selectedKeys,
}: {
  onSelect: (p: FgPlayer) => void;
  disabled: boolean;
  playerTypeFilter: 'h' | 'p';
  season: number;
  selectedKeys: Set<string>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FgPlayer[]>([]);
  const [isTeamSearch, setIsTeamSearch] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (query.length < 2) { setResults([]); setOpen(false); setIsTeamSearch(false); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/fg-search?str=${encodeURIComponent(query)}&season=${season}`);
        const data: FgPlayer[] = await res.json();
        // Detect team search: all results share the same non-empty team
        const teamSearch = data.length > 2 && data.every(p => p.team && p.team === data[0].team);
        setIsTeamSearch(teamSearch);
        setResults(data);
        setOpen(data.length > 0);
        setHighlighted(-1);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 280);
    return () => clearTimeout(timer.current);
  }, [query, season]);

  function select(p: FgPlayer) {
    const key = `${p.playerid}-${p.searchType}`;
    if (selectedKeys.has(key)) return; // already added
    onSelect(p);
    if (isTeamSearch) {
      // Keep dropdown open so user can pick more teammates
      inputRef.current?.focus();
    } else {
      setQuery('');
      setResults([]);
      setOpen(false);
      inputRef.current?.focus();
    }
  }

  const visibleResults = results.filter(p => p.searchType === playerTypeFilter);

  function handleKey(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, visibleResults.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && highlighted >= 0) { e.preventDefault(); select(visibleResults[highlighted]); }
    if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKey}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={disabled ? 'Max 5 players' : 'Search player or team…'}
        disabled={disabled}
        className="search-input"
        autoComplete="off"
      />
      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-xs">…</span>
      )}
      {open && (
        <ul ref={listRef} className="search-dropdown">
          {visibleResults.map((p, i) => {
            const key = `${p.playerid}-${p.searchType}`;
            const added = selectedKeys.has(key);
            return (
              <li
                key={key}
                className={`search-item ${i === highlighted ? 'highlighted' : ''} ${added ? 'added' : ''}`}
                onMouseDown={() => select(p)}
                onMouseEnter={() => setHighlighted(i)}
                style={{ opacity: added ? 0.4 : 1, cursor: added ? 'default' : 'pointer' }}
              >
                <span className="search-name">{p.name}</span>
                <span className="search-meta">
                  {added ? '✓ ' : ''}{p.team ?? ''}{p.pos ? ` · ${p.pos}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Custom Dot (headshot at last rolling point) ──────────────────────────────

function makeHeadshotDot(
  playerId: string,
  headshotSrc: string | null,
  lastValidIndex: number,
  color: string,
) {
  const Dot = (props: Record<string, unknown>) => {
    const { cx, cy, index } = props as { cx: number; cy: number; index: number };
    if (index !== lastValidIndex || cx === undefined || cy === undefined) return null;
    const r = 17;
    const clipId = `clip-hs-${playerId}`;
    return (
      <g>
        <defs>
          <clipPath id={clipId}>
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
        </defs>
        <circle cx={cx} cy={cy} r={r + 2} fill="#fff" stroke={color} strokeWidth={2} />
        {headshotSrc ? (
          <image
            href={headshotSrc}
            x={cx - r}
            y={cy - r}
            width={r * 2}
            height={r * 2}
            clipPath={`url(#${clipId})`}
          />
        ) : (
          <circle cx={cx} cy={cy} r={r} fill={color} />
        )}
      </g>
    );
  };
  Dot.displayName = 'HeadshotDot';
  return Dot;
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  label,
  players,
  metric,
  rollingWindow,
}: {
  active?: boolean;
  payload?: Array<{ color: string; value: number | null; dataKey: string }>;
  label?: string;
  players: SelectedPlayer[];
  metric: typeof METRICS[number];
  rollingWindow: number;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="tooltip-box">
      <div className="tooltip-game">{label ? formatDate(label) : ''}</div>
      {payload.map(entry => {
        const player = players.find(p => `${p.playerid}-${p.searchType}` === entry.dataKey);
        if (!player || entry.value === null || entry.value === undefined) return null;
        // Use the stored game index (gi_) so carry-forward dates still show correct window range
        const point = (entry as unknown as { payload: Record<string, unknown> }).payload;
        const gameIdx = (point[`gi_${entry.dataKey}`] as number) ?? -1;
        const windowStartIdx = gameIdx !== -1 ? (player.windowStarts[gameIdx] ?? gameIdx) : -1;
        const windowStartDate = windowStartIdx !== -1 ? player.gameDates[windowStartIdx] : null;
        const windowEndDate = gameIdx !== -1 ? player.gameDates[gameIdx] : String(label);
        return (
          <div key={entry.dataKey} className="tooltip-row">
            <span className="tooltip-dot" style={{ background: entry.color }} />
            <span className="tooltip-name">{player.name}</span>
            <div className="tooltip-vals">
              <span className="tooltip-rolling">{formatVal(entry.value, metric)}</span>
              {windowStartDate && (
                <span className="tooltip-raw">
                  {windowStartDate === windowEndDate
                    ? formatDate(windowStartDate)
                    : `${formatDate(windowStartDate)} – ${formatDate(windowEndDate)}`}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Custom Legend ────────────────────────────────────────────────────────────

function ChartLegend({ players }: { players: SelectedPlayer[] }) {
  return (
    <div className="chart-legend">
      {players.map(p => (
        <div key={`${p.playerid}-${p.searchType}`} className="legend-item">
          <span className="legend-line" style={{ background: p.color }} />
          <span className="legend-name">{p.name}</span>
          {p.totalGames < 5 && (
            <span className="legend-warn">({p.totalGames} games)</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main Tool ────────────────────────────────────────────────────────────────

export default function RollingTool() {
  // Parse URL state once (before first render) so lazy initialisers can use it
  const urlStateRef = useRef<ReturnType<typeof parseUrlState>>(null);
  if (!urlStateRef.current) urlStateRef.current = parseUrlState();
  const urlState = urlStateRef.current;

  const [playerType, setPlayerType] = useState<'hit' | 'pit'>(urlState?.playerType ?? 'hit');
  const colorIndex = useRef(urlState?.players.length ?? 0);
  const [selectedPlayers, setSelectedPlayers] = useState<SelectedPlayer[]>(urlState?.players ?? []);
  const [metric, setMetric] = useState<MetricLabel>(urlState?.metric ?? 'wOBA');
  const [rollingWindow, setRollingWindow] = useState<number>(urlState?.rollingWindow ?? 15);
  const [windowInput, setWindowInput] = useState<string>(String(urlState?.rollingWindow ?? 15));
  const [season, setSeason] = useState<number>(urlState?.season ?? 2026);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<Record<string, unknown>[]>([]);
  const [plotPlayers, setPlotPlayers] = useState<SelectedPlayer[]>([]);
  const [plotMetric, setPlotMetric] = useState<typeof METRICS[number]>(getMetric(urlState?.metric ?? 'wOBA'));

  // ── URL sync: update address bar whenever shareable state changes ──────────
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', playerType);
    params.set('metric', metric);
    params.set('window', String(rollingWindow));
    params.set('season', String(season));
    for (const p of selectedPlayers) {
      params.append('p', `${p.playerid}|${p.mlbamid ?? ''}|${p.searchType}|${encodeURIComponent(p.name)}`);
    }
    window.history.replaceState(null, '', `?${params.toString()}`);
  }, [playerType, metric, rollingWindow, season, selectedPlayers]);

  // Metrics available for the active tab
  const tabMetrics = METRICS.filter(m => m.category !== (playerType === 'hit' ? 'pit' : 'hit'));

  function switchTab(type: 'hit' | 'pit') {
    if (type === playerType) return;
    setPlayerType(type);
    setSelectedPlayers([]);
    setChartData([]);
    setPlotPlayers([]);
    setError(null);
    colorIndex.current = 0;
    // Default metric for this tab
    const first = METRICS.find(m => m.category !== (type === 'hit' ? 'pit' : 'hit'));
    if (first) setMetric(first.label);
  }

  function addPlayer(p: FgPlayer) {
    if (selectedPlayers.length >= 5) return;
    const key = `${p.playerid}-${p.searchType}`;
    if (selectedPlayers.some(sp => `${sp.playerid}-${sp.searchType}` === key)) return;
    const color = PLAYER_COLORS[colorIndex.current % PLAYER_COLORS.length];
    colorIndex.current += 1;
    setSelectedPlayers(prev => [...prev, {
      ...p,
      color,
      rolling: [],
      windowStarts: [],
      gameDates: [],
      gameVals: [],
      lastValidIndex: -1,
      totalGames: 0,
      headshotUrl: headshotUrl(p.mlbamid),
    }]);
  }

  function removePlayer(key: string) {
    setSelectedPlayers(prev => prev.filter(p => `${p.playerid}-${p.searchType}` !== key));
  }

  function clearAll() {
    setSelectedPlayers([]);
    setChartData([]);
    setPlotPlayers([]);
    setError(null);
    colorIndex.current = 0;
  }

  const metricConfig = getMetric(metric);

  // Determine game log type from metric category
  function gameLogType(player: FgPlayer): number {
    if (metricConfig.category === 'hit') return 0;
    if (metricConfig.category === 'pit') return 1;
    // 'both' → use player's natural type
    return player.gameLogType;
  }

  const plot = useCallback(async () => {
    if (selectedPlayers.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      const mc = getMetric(metric);
      const enriched: SelectedPlayer[] = await Promise.all(
        selectedPlayers.map(async (player) => {
          const type = gameLogType(player);
          const res = await fetch(
            `/api/fg-gamelog?playerid=${player.playerid}&type=${type}&season=${season}`
          );
          if (!res.ok) throw new Error(`Failed to load ${player.name}`);
          const games: GameLog[] = await res.json();

          if (!Array.isArray(games) || games.length === 0) {
            return { ...player, rolling: [], windowStarts: [], gameDates: [], gameVals: [], lastValidIndex: -1, totalGames: 0 };
          }

          const rawVals = games.map(g => parseVal(g[mc.field]));
          // Weights: PA for hitters, IP for pitcher counting stats, BF for pitcher rate stats
          const wf = mc.weightField;
          const rawWeights = games.map(g =>
            wf === 'IP' ? parseIP(g[wf]) : parseVal(g[wf])
          );
          // Strip HTML from FanGraphs date strings (<a href="...">2026-04-28</a>)
          const dates = games.map(g => stripHtml(String(g.Date ?? g.date ?? '')));
          const { rolling, windowStarts } = computeRolling(rawVals, rawWeights, rollingWindow);

          return {
            ...player,
            rolling,
            windowStarts,
            gameDates: dates,
            gameVals: rawVals,
            lastValidIndex: -1, // will be set after chart data is built
            totalGames: games.length,
          };
        })
      );

      // Build a unified, sorted date axis covering every game date across all players
      const allDates = [...new Set(enriched.flatMap(p => p.gameDates.filter(Boolean)))].sort();

      // Build per-player date → {rolling, raw, gameIdx} maps (last game wins for doubleheaders)
      const dateMaps = enriched.map(p => {
        const map = new Map<string, { rolling: number | null; raw: number | null; gameIdx: number }>();
        p.gameDates.forEach((date, i) => {
          if (date) map.set(date, { rolling: p.rolling[i] ?? null, raw: p.gameVals[i] ?? null, gameIdx: i });
        });
        return map;
      });

      // Chart data indexed by date — carry the last rolling value forward on rest days
      // so lines are continuous. gi_ stores the effective game index for tooltip date ranges.
      const lastKnown: (number | null)[] = enriched.map(() => null);
      const lastGameIdx: number[] = enriched.map(() => -1);

      const data = allDates.map(date => {
        const point: Record<string, unknown> = { date };
        enriched.forEach((p, pi) => {
          const key = `${p.playerid}-${p.searchType}`;
          const entry = dateMaps[pi].get(date);
          if (entry && entry.rolling !== null) {
            lastKnown[pi] = entry.rolling;
            lastGameIdx[pi] = entry.gameIdx;
          }
          // Always emit a value once the player has started (carry forward on rest days)
          if (lastKnown[pi] !== null) {
            point[key] = lastKnown[pi];
            point[`gi_${key}`] = lastGameIdx[pi]; // effective game index for tooltip
          }
        });
        return point;
      });

      // lastValidIndex = chart index of each player's last *actual* game (for headshot dot)
      const enrichedFinal = enriched.map((p, pi) => {
        let lastValidIndex = -1;
        allDates.forEach((date, i) => {
          if (dateMaps[pi].has(date)) lastValidIndex = i;
        });
        return { ...p, lastValidIndex };
      });

      setPlotPlayers(enrichedFinal);
      setPlotMetric(mc);
      setChartData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlayers, metric, rollingWindow, season]);

  // Auto-plot on mount if players were restored from URL
  const didAutoPlot = useRef(false);
  useEffect(() => {
    if (!didAutoPlot.current && selectedPlayers.length > 0) {
      didAutoPlot.current = true;
      plot();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot]);

  const isCumulative = plotPlayers.length > 0 && plotPlayers.every(p => rollingWindow > p.totalGames);
  const chartTitle = isCumulative
    ? `Cumulative ${plotMetric.label} — ${season}`
    : `${rollingWindow}-Game Rolling ${plotMetric.label} — ${season}`;

  // Y-axis domain with padding
  const yVals = chartData.flatMap(d =>
    plotPlayers.map(p => d[`${p.playerid}-${p.searchType}`] as number | undefined)
  ).filter((v): v is number => v !== undefined && !isNaN(v));

  let yMin = Math.min(...yVals);
  let yMax = Math.max(...yVals);
  if (yVals.length === 0) { yMin = 0; yMax = 1; }
  const yPad = (yMax - yMin) * 0.15 || 0.05;
  const yDomain: [number, number] = [
    parseFloat((yMin - yPad).toFixed(3)),
    parseFloat((yMax + yPad).toFixed(3)),
  ];

  const hasChart = chartData.length > 0 && plotPlayers.length > 0;

  return (
    <div className="tool-root">
      {/* Header */}
      <header className="tool-header">
        <div className="header-inner">
          <div>
            <h1 className="tool-title">Rolling Metric Chart</h1>
            <p className="tool-sub">Compare player trajectories across the season</p>
          </div>
        </div>
      </header>

      <main className="tool-main">
        {/* Tab bar */}
        <div className="tab-bar">
          <button
            className={`tab ${playerType === 'hit' ? 'active' : ''}`}
            onClick={() => switchTab('hit')}
          >
            Hitter Rolling Chart
          </button>
          <button
            className={`tab ${playerType === 'pit' ? 'active' : ''}`}
            onClick={() => switchTab('pit')}
          >
            Pitcher Rolling Chart
          </button>
        </div>

        {/* Controls card */}
        <div className="card controls-card">
          <div className="controls-row">
            {/* Player search */}
            <div className="control-group" style={{ flex: '1 1 260px' }}>
              <label className="control-label">Add Player</label>
              <PlayerSearch
                onSelect={addPlayer}
                disabled={selectedPlayers.length >= 5}
                playerTypeFilter={playerType === 'hit' ? 'h' : 'p'}
                season={season}
                selectedKeys={new Set(selectedPlayers.map(p => `${p.playerid}-${p.searchType}`))}
              />
            </div>

            {/* Metric */}
            <div className="control-group">
              <label className="control-label">Metric</label>
              <select
                className="select-input"
                value={metric}
                onChange={e => setMetric(e.target.value as MetricLabel)}
              >
                {tabMetrics.map(m => (
                  <option key={m.label} value={m.label}>{m.label}</option>
                ))}
              </select>
            </div>

            {/* Window */}
            <div className="control-group">
              <label className="control-label">Window (games)</label>
              <input
                type="number"
                className="select-input window-input"
                min={WINDOW_MIN}
                max={WINDOW_MAX}
                value={windowInput}
                onChange={e => setWindowInput(e.target.value)}
                onBlur={() => {
                  const v = parseInt(windowInput);
                  const clamped = isNaN(v) ? rollingWindow : Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, v));
                  setRollingWindow(clamped);
                  setWindowInput(String(clamped));
                }}
              />
            </div>

            {/* Season */}
            <div className="control-group">
              <label className="control-label">Season</label>
              <select
                className="select-input"
                value={season}
                onChange={e => setSeason(Number(e.target.value))}
              >
                {SEASONS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            {/* Buttons */}
            <div className="control-group btn-group">
              <button
                className="btn-plot"
                onClick={plot}
                disabled={loading || selectedPlayers.length === 0}
              >
                {loading ? 'Loading…' : 'Plot'}
              </button>
              <button className="btn-clear" onClick={clearAll}>Clear all</button>
            </div>
          </div>

          {/* Player chips */}
          {selectedPlayers.length > 0 && (
            <div className="chips-row">
              {selectedPlayers.map(p => {
                const key = `${p.playerid}-${p.searchType}`;
                return (
                  <div key={key} className="chip" style={{ borderColor: p.color }}>
                    {p.headshotUrl && (
                      <img
                        src={p.headshotUrl}
                        alt={p.name}
                        className="chip-avatar"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    )}
                    <span className="chip-dot" style={{ background: p.color }} />
                    <span className="chip-name">{p.name}</span>
                    {p.searchType === 'p' && <span className="chip-badge">P</span>}
                    <button className="chip-remove" onClick={() => removePlayer(key)}>×</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Chart card */}
        <div className="card chart-card">
          {error && (
            <div className="chart-message error">{error}</div>
          )}

          {!hasChart && !loading && !error && (
            <div className="chart-message">
              <span>Add players and click <strong>Plot</strong> to compare rolling averages</span>
            </div>
          )}

          {loading && (
            <div className="chart-message">Loading game logs…</div>
          )}

          {hasChart && !loading && (
            <>
              <div className="chart-title">{chartTitle}</div>
              <ChartLegend players={plotPlayers} />
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 16, right: 28, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ede9e4" />
                    <XAxis
                      dataKey="date"
                      type="category"
                      ticks={pickTicks(chartData.map(d => d.date as string))}
                      tickFormatter={formatDate}
                      tick={{ fill: '#999', fontSize: 11 }}
                      stroke="#d8d5d0"
                    />
                    <YAxis
                      domain={yDomain}
                      tickFormatter={v => {
                        if (plotMetric.isPercent) return `${(v * 100).toFixed(plotMetric.decimals)}%`;
                        return v.toFixed(plotMetric.decimals);
                      }}
                      tick={{ fill: '#999', fontSize: 11 }}
                      stroke="#d8d5d0"
                      width={60}
                    />
                    <Tooltip
                      content={
                        <CustomTooltip
                          players={plotPlayers}
                          metric={plotMetric}
                          rollingWindow={rollingWindow}
                        />
                      }
                      cursor={{ stroke: 'rgba(0,0,0,0.12)', strokeWidth: 1 }}
                    />
                    {/* MLB average reference line */}
                    {plotMetric.avg !== undefined && (
                      <ReferenceLine
                        y={plotMetric.avg}
                        stroke="rgba(0,0,0,0.18)"
                        strokeDasharray="6 3"
                        label={{
                          value: `MLB avg ${plotMetric.isPercent
                            ? `${(plotMetric.avg * 100).toFixed(1)}%`
                            : plotMetric.avg.toFixed(plotMetric.decimals)}`,
                          fill: '#999',
                          fontSize: 10,
                          position: 'insideTopRight',
                        }}
                      />
                    )}
                    {plotPlayers.map(player => {
                      const key = `${player.playerid}-${player.searchType}`;
                      return (
                        <Line
                          key={key}
                          type="monotone"
                          dataKey={key}
                          stroke={player.color}
                          strokeWidth={2.5}
                          dot={makeHeadshotDot(key, player.headshotUrl, player.lastValidIndex, player.color)}
                          activeDot={{ r: 4, fill: player.color, stroke: '#fff', strokeWidth: 2 }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>

        {/* Attribution */}
        <div className="attribution">Data: <a href="https://www.fangraphs.com" target="_blank" rel="noopener noreferrer">FanGraphs</a></div>
      </main>
    </div>
  );
}
