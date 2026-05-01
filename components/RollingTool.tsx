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
  ReferenceArea,
  ResponsiveContainer,
  Legend,
  usePlotArea,
  useYAxisScale,
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
const PLAYER_COLORS = ['#0072B2', '#E69F00', '#CC79A7', '#009E73', '#56B4E9', '#D55E00', '#999999'];
const MAX_PLAYERS = 7;
const MAX_QUICK_REGULARS = 7;
const MAX_QUICK_ROLE = 5;

// MLB team primary colors (chosen for legibility on a light background)
const TEAM_COLORS: Record<string, string> = {
  ARI: '#A71930',
  ATL: '#CE1141',
  BAL: '#DF4601',
  BOS: '#BD3039',
  CHC: '#0E3386',
  CIN: '#C6011F',
  CLE: '#E31937',
  COL: '#33006F',
  CWS: '#27251F',
  DET: '#0C2340',
  HOU: '#F4911E',
  KC:  '#004687',
  LAA: '#BA0021',
  LAD: '#005A9C',
  MIA: '#00A3E0',
  MIL: '#FFC52F',
  MIN: '#D31145',
  NYM: '#FF5910',
  NYY: '#003087',
  OAK: '#EFB21E',
  PHI: '#E81828',
  PIT: '#FDB827',
  SD:  '#2F241D',
  SEA: '#005C5C',
  SF:  '#FD5A1E',
  STL: '#C41E3A',
  TB:  '#8FBCE6',
  TEX: '#C0111F',
  TOR: '#134A8E',
  WSH: '#AB0003',
};

// Returns a playerKey→color map. Uses team colors when every player is on a
// different team and all teams have a known color; otherwise uses palette colors.
function effectiveColors(players: { playerid: string; searchType: string; team?: string; color: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  if (players.length === 0) return map;

  const teams = players.map(p => p.team ?? '');
  const useTeam =
    teams.every(t => t && TEAM_COLORS[t]) &&   // all teams known
    new Set(teams).size === teams.length;        // all different teams

  players.forEach(p => {
    map.set(`${p.playerid}-${p.searchType}`, useTeam ? TEAM_COLORS[p.team!]! : p.color);
  });
  return map;
}

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

// ─── Chart layout: right-side y-axis + headshot label column ─────────────────
const CM      = { top: 20, right: 58, bottom: 8, left: 8 } as const;
const YAXIS_W = 48;  // right-side y-axis width (px)
const HS_R    = 17;  // headshot circle radius (px)

const MLB_TEAM_LIST = [
  { abbr: 'ARI', name: 'Arizona Diamondbacks' },
  { abbr: 'ATL', name: 'Atlanta Braves' },
  { abbr: 'BAL', name: 'Baltimore Orioles' },
  { abbr: 'BOS', name: 'Boston Red Sox' },
  { abbr: 'CHC', name: 'Chicago Cubs' },
  { abbr: 'CWS', name: 'Chicago White Sox' },
  { abbr: 'CIN', name: 'Cincinnati Reds' },
  { abbr: 'CLE', name: 'Cleveland Guardians' },
  { abbr: 'COL', name: 'Colorado Rockies' },
  { abbr: 'DET', name: 'Detroit Tigers' },
  { abbr: 'HOU', name: 'Houston Astros' },
  { abbr: 'KC',  name: 'Kansas City Royals' },
  { abbr: 'LAA', name: 'Los Angeles Angels' },
  { abbr: 'LAD', name: 'Los Angeles Dodgers' },
  { abbr: 'MIA', name: 'Miami Marlins' },
  { abbr: 'MIL', name: 'Milwaukee Brewers' },
  { abbr: 'MIN', name: 'Minnesota Twins' },
  { abbr: 'NYM', name: 'New York Mets' },
  { abbr: 'NYY', name: 'New York Yankees' },
  { abbr: 'OAK', name: 'Oakland Athletics' },
  { abbr: 'PHI', name: 'Philadelphia Phillies' },
  { abbr: 'PIT', name: 'Pittsburgh Pirates' },
  { abbr: 'SD',  name: 'San Diego Padres' },
  { abbr: 'SEA', name: 'Seattle Mariners' },
  { abbr: 'SF',  name: 'San Francisco Giants' },
  { abbr: 'STL', name: 'St. Louis Cardinals' },
  { abbr: 'TB',  name: 'Tampa Bay Rays' },
  { abbr: 'TEX', name: 'Texas Rangers' },
  { abbr: 'TOR', name: 'Toronto Blue Jays' },
  { abbr: 'WSH', name: 'Washington Nationals' },
] as const;

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
//
// FanGraphs counts EVERY game appearance (including 0-PA pinch-runner games)
// as a slot in the N-game window. A 0-PA game consumes a slot but contributes
// nothing to the weighted sum. We match that behaviour: count a game whenever
// its weight is defined (even w=0), only add to sum when w > 0.
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
      const w = weights[j];
      // A game with a defined weight (even 0 PA) counts as a window slot
      if (w !== null && w !== undefined) {
        count++;
        startIdx = j;
        const v = vals[j];
        // Only accumulate into the weighted sum when there was real activity
        if (w > 0 && v !== null && v !== undefined) {
          sumVW += v * w;
          sumW  += w;
        }
      }
    }
    if (sumW === 0) {
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
  return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_120,q_auto:best/v1/people/${mlbamid}/headshot/67/current`;
}

// ─── URL state helpers ────────────────────────────────────────────────────────

function decodePlayerParam(s: string, color: string): SelectedPlayer | null {
  // Format: "{fgId}|{mlbamid}|{searchType}|{encodedName}|{team}"
  // team is optional (old URLs omit it) — falls back to '' which disables team colors
  const parts = s.split('|');
  if (parts.length < 4) return null;
  const [playerid, mlbamidStr, searchType, encodedName, team] = parts;
  if (!playerid || (searchType !== 'h' && searchType !== 'p')) return null;
  const mlbamid = mlbamidStr ? parseInt(mlbamidStr) || null : null;
  const name = decodeURIComponent(encodedName);
  return {
    playerid,
    name,
    mlbamid,
    gameLogType: searchType === 'p' ? 1 : 0,
    searchType,
    team: team ?? '',
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
  for (const encoded of p.getAll('p').slice(0, MAX_PLAYERS)) {
    const color = PLAYER_COLORS[players.length % PLAYER_COLORS.length];
    const player = decodePlayerParam(encoded, color);
    if (player) players.push(player);
  }

  return { playerType, metric, rollingWindow, season, players };
}

// ─── Team matching (client-side) ──────────────────────────────────────────────

const MLB_TEAMS_CLIENT = [
  { abbr: 'BAL', terms: ['baltimore', 'orioles', 'bal', "o's", 'os'] },
  { abbr: 'BOS', terms: ['boston', 'red sox', 'redsox', 'bos'] },
  { abbr: 'NYY', terms: ['new york yankees', 'yankees', 'nyy', 'ny yankees'] },
  { abbr: 'TB',  terms: ['tampa bay', 'rays', 'tb', 'tampa'] },
  { abbr: 'TOR', terms: ['toronto', 'blue jays', 'bluejays', 'jays', 'tor'] },
  { abbr: 'CWS', terms: ['chicago white sox', 'white sox', 'whitesox', 'cws', 'chisox'] },
  { abbr: 'CLE', terms: ['cleveland', 'guardians', 'cle'] },
  { abbr: 'DET', terms: ['detroit', 'tigers', 'det'] },
  { abbr: 'KC',  terms: ['kansas city', 'royals', 'kc'] },
  { abbr: 'MIN', terms: ['minnesota', 'twins', 'min'] },
  { abbr: 'HOU', terms: ['houston', 'astros', 'hou'] },
  { abbr: 'LAA', terms: ['los angeles angels', 'angels', 'laa', 'la angels', 'anaheim'] },
  { abbr: 'OAK', terms: ['oakland', 'athletics', 'oak', "a's", 'as'] },
  { abbr: 'SEA', terms: ['seattle', 'mariners', 'sea', "m's", 'ms'] },
  { abbr: 'TEX', terms: ['texas', 'rangers', 'tex'] },
  { abbr: 'ATL', terms: ['atlanta', 'braves', 'atl'] },
  { abbr: 'MIA', terms: ['miami', 'marlins', 'mia'] },
  { abbr: 'NYM', terms: ['new york mets', 'mets', 'nym', 'ny mets'] },
  { abbr: 'PHI', terms: ['philadelphia', 'phillies', 'phi', 'phils'] },
  { abbr: 'WSH', terms: ['washington', 'nationals', 'wsh', 'nats'] },
  { abbr: 'CHC', terms: ['chicago cubs', 'cubs', 'chc'] },
  { abbr: 'CIN', terms: ['cincinnati', 'reds', 'cin'] },
  { abbr: 'MIL', terms: ['milwaukee', 'brewers', 'mil'] },
  { abbr: 'PIT', terms: ['pittsburgh', 'pirates', 'pit', 'bucs'] },
  { abbr: 'STL', terms: ['st. louis', 'st louis', 'cardinals', 'stl', 'cards'] },
  { abbr: 'ARI', terms: ['arizona', 'diamondbacks', 'd-backs', 'dbacks', 'ari'] },
  { abbr: 'COL', terms: ['colorado', 'rockies', 'col', 'rox'] },
  { abbr: 'LAD', terms: ['los angeles dodgers', 'dodgers', 'lad', 'la dodgers'] },
  { abbr: 'SD',  terms: ['san diego', 'padres', 'sd'] },
  { abbr: 'SF',  terms: ['san francisco', 'giants', 'sf'] },
] as const;

function matchTeamClient(query: string): string | null {
  if (query.length < 2) return null;
  const q = query.toLowerCase().trim();
  for (const team of MLB_TEAMS_CLIENT) {
    for (const term of team.terms) {
      if (term.startsWith(q) || term === q) return team.abbr;
    }
  }
  return null;
}

// ─── Player Search Component ──────────────────────────────────────────────────

function PlayerSearch({
  onSelect,
  disabled,
  playerTypeFilter,
  playerPool,
  poolLoading,
  selectedKeys,
}: {
  onSelect: (p: FgPlayer) => void;
  disabled: boolean;
  playerTypeFilter: 'h' | 'p';
  playerPool: FgPlayer[];
  poolLoading: boolean;
  selectedKeys: Set<string>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FgPlayer[]>([]);
  const [isTeamSearch, setIsTeamSearch] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (query.length < 2) { setResults([]); setOpen(false); setIsTeamSearch(false); return; }

    const q = query.toLowerCase().trim();
    const teamAbbr = matchTeamClient(q);
    let filtered: FgPlayer[];
    let teamSearch = false;

    if (teamAbbr) {
      // Team search: show all players on that team (both hitters and pitchers)
      filtered = playerPool
        .filter(p => p.team === teamAbbr)
        .sort((a, b) => {
          const aLast = a.name.split(' ').slice(-1)[0];
          const bLast = b.name.split(' ').slice(-1)[0];
          return aLast.localeCompare(bLast);
        });
      teamSearch = true;
    } else {
      // Name search: restrict to active tab, sort starts-with first, cap at 20
      filtered = playerPool
        .filter(p => p.searchType === playerTypeFilter && p.name.toLowerCase().includes(q))
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
          const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
          return aStarts - bStarts || a.name.localeCompare(b.name);
        })
        .slice(0, 20);
    }

    setIsTeamSearch(teamSearch);
    setResults(filtered);
    setOpen(filtered.length > 0);
    setHighlighted(-1);
  }, [query, playerPool]);

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

  // Always filter results to the active tab (hitter or pitcher).
  // For team searches the full roster is in `results`; for name searches it's the top 20.
  const visibleResults = results.filter(p => p.searchType === playerTypeFilter);

  function handleKey(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, visibleResults.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && highlighted >= 0) { e.preventDefault(); select(visibleResults[highlighted]); }
    if (e.key === 'Escape') { setOpen(false); }
  }

  const placeholder = disabled
    ? `Max ${MAX_PLAYERS} players`
    : poolLoading
      ? 'Loading players…'
      : 'Search player or team…';

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
        placeholder={placeholder}
        disabled={disabled || poolLoading}
        className="search-input"
        autoComplete="off"
      />
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

// ─── Right-side headshot label column: stack positions to avoid overlap ──────
// Sorts items by idealY, sweeps down pushing overlaps apart, then sweeps back
// up if the last item overflows the bottom bound. Restores original order.
function stackPositions(
  idealYs: number[],
  minGap: number,
  topBound: number,
  bottomBound: number,
): number[] {
  const n = idealYs.length;
  if (n === 0) return [];
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => idealYs[a] - idealYs[b]);
  const cy = order.map(i => idealYs[i]);
  // Sweep down
  for (let j = 1; j < cy.length; j++) {
    if (cy[j] - cy[j - 1] < minGap) cy[j] = cy[j - 1] + minGap;
  }
  // If last overflows, sweep back up from the bottom
  if (cy[cy.length - 1] > bottomBound) {
    cy[cy.length - 1] = bottomBound;
    for (let j = cy.length - 2; j >= 0; j--) {
      if (cy[j + 1] - cy[j] < minGap) cy[j] = cy[j + 1] - minGap;
    }
  }
  for (let j = 0; j < cy.length; j++) {
    cy[j] = Math.max(topBound, Math.min(bottomBound, cy[j]));
  }
  const result = new Array(n);
  order.forEach((orig, sorted) => { result[orig] = cy[sorted]; });
  return result;
}

// ─── Headshot label layer — uses Recharts 3.x hooks for pixel-perfect layout ─
// Rendered as a direct child of LineChart (Recharts 3.x supports arbitrary
// children). usePlotArea() gives exact plot bounds; useYAxisScale() gives the
// live D3 scale so yScale(value) → pixel y, no manual math needed.
function HeadshotLayer({ players, lineColors, lastRow }: {
  players:    SelectedPlayer[];
  lineColors: Map<string, string>;
  lastRow:    Record<string, unknown> | null;
}) {
  const plotArea = usePlotArea();
  const yScale   = useYAxisScale(0);   // yAxisId 0 = default right-side axis

  if (!plotArea || !yScale) return null;

  const plotRight = plotArea.x + plotArea.width;
  const plotTop   = plotArea.y;
  const plotBot   = plotArea.y + plotArea.height;

  // Headshots live in the CM.right margin, past the y-axis ticks
  const hsCx = plotRight + YAXIS_W + HS_R + 4;

  const mid = (plotTop + plotBot) / 2;
  const idealYs = players.map(p => {
    if (!lastRow) return mid;
    const v = lastRow[`${p.playerid}-${p.searchType}`] as number | undefined;
    if (v === undefined) return mid;
    return yScale(v) ?? mid;
  });

  const stackedCys = stackPositions(
    idealYs, HS_R * 2 + 6, plotTop + HS_R + 2, plotBot - HS_R - 2,
  );

  return (
    <>
      <defs>
        {players.map((player, pi) => {
          const key = `${player.playerid}-${player.searchType}`;
          return (
            <clipPath key={key} id={`hs-ov-${key}`}>
              <circle cx={hsCx} cy={stackedCys[pi]} r={HS_R} />
            </clipPath>
          );
        })}
      </defs>
      {players.map((player, pi) => {
        const key   = `${player.playerid}-${player.searchType}`;
        const clr   = lineColors.get(key) ?? player.color;
        const idealY = idealYs[pi];
        const cy     = stackedCys[pi];
        return (
          <g key={key}>
            {/* Leader line from where the player's chart line ends to the headshot */}
            <line
              x1={plotRight} y1={idealY}
              x2={hsCx - HS_R - 2} y2={cy}
              stroke={clr} strokeWidth={1.5} strokeOpacity={0.6}
            />
            {player.headshotUrl ? (
              <>
                {/* White background behind image */}
                <circle cx={hsCx} cy={cy} r={HS_R} fill="#fff" />
                {/* Face-cropped headshot: preserveAspectRatio mirrors object-fit:cover + object-position:50% 0% */}
                <image
                  href={player.headshotUrl}
                  x={hsCx - HS_R} y={cy - HS_R + 1}
                  width={HS_R * 2} height={HS_R * 2 - 1}
                  preserveAspectRatio="xMidYMin slice"
                  clipPath={`url(#hs-ov-${key})`}
                />
                {/* Thin gray border ring drawn on top */}
                <circle cx={hsCx} cy={cy} r={HS_R} fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth={1} />
              </>
            ) : (
              <circle cx={hsCx} cy={cy} r={HS_R} fill={clr} />
            )}
          </g>
        );
      })}
    </>
  );
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

function ChartLegend({ players, colors }: { players: SelectedPlayer[]; colors: Map<string, string> }) {
  return (
    <div className="chart-legend">
      {players.map(p => {
        const key = `${p.playerid}-${p.searchType}`;
        const clr = colors.get(key) ?? p.color;
        return (
          <div key={key} className="legend-item">
            <span className="legend-line" style={{ background: clr }} />
            <span className="legend-name">{p.name}</span>
            {p.totalGames < 5 && (
              <span className="legend-warn">({p.totalGames} games)</span>
            )}
          </div>
        );
      })}
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

  // ── Player pool: all FG players preloaded for instant client-side search ──
  const [playerPool, setPlayerPool] = useState<FgPlayer[]>([]);
  const [poolLoading, setPoolLoading] = useState(true);


  // ── Quick-add by team (hitter tab only) ──────────────────────────────────
  const [quickTeam, setQuickTeam] = useState('');
  const [quickLoading, setQuickLoading] = useState(false);

  // ── Drag-to-zoom ─────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState<{
    isSelecting: boolean;
    selLeft: string | null;
    selRight: string | null;
    zoomedLeft: string | null;
    zoomedRight: string | null;
  }>({ isSelecting: false, selLeft: null, selRight: null, zoomedLeft: null, zoomedRight: null });
  const resetZoom = () =>
    setZoom({ isSelecting: false, selLeft: null, selRight: null, zoomedLeft: null, zoomedRight: null });

  // Commit or cancel zoom when mouse is released anywhere (even outside chart)
  useEffect(() => {
    if (!zoom.isSelecting) return;
    const up = () => {
      setZoom(z => {
        if (z.isSelecting && z.selLeft && z.selRight && z.selLeft !== z.selRight) {
          const [l, r] = [z.selLeft, z.selRight].sort();
          return { isSelecting: false, selLeft: null, selRight: null, zoomedLeft: l, zoomedRight: r };
        }
        return { ...z, isSelecting: false, selLeft: null, selRight: null };
      });
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [zoom.isSelecting]);

  useEffect(() => {
    setPoolLoading(true);
    fetch(`/api/fg-players?season=${season}`)
      .then(r => r.json())
      .then((data: unknown) => setPlayerPool(Array.isArray(data) ? data as FgPlayer[] : []))
      .catch(() => setPlayerPool([]))
      .finally(() => setPoolLoading(false));
  }, [season]);

  // ── URL sync: update address bar whenever shareable state changes ──────────
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', playerType);
    params.set('metric', metric);
    params.set('window', String(rollingWindow));
    params.set('season', String(season));
    for (const p of selectedPlayers) {
      params.append('p', `${p.playerid}|${p.mlbamid ?? ''}|${p.searchType}|${encodeURIComponent(p.name)}|${p.team ?? ''}`);
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
    setQuickTeam('');
    // Default metric for this tab
    const first = METRICS.find(m => m.category !== (type === 'hit' ? 'pit' : 'hit'));
    if (first) setMetric(first.label);
  }

  function addPlayer(p: FgPlayer) {
    if (selectedPlayers.length >= MAX_PLAYERS) return;
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
    resetZoom();
  }

  async function quickAdd(mode: 'regulars' | 'top5' | 'bottom5') {
    if (!quickTeam || quickLoading) return;
    setQuickLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        team: quickTeam,
        season: String(season),
        mode,
        metric,
      });
      const res = await fetch(`/api/fg-team-hitters?${qs}`);
      const incoming: FgPlayer[] = await res.json();
      if (!Array.isArray(incoming) || incoming.length === 0) return;

      // Replace current selection with the quick-add set
      colorIndex.current = 0;
      setChartData([]);
      setPlotPlayers([]);
      setSelectedPlayers(
        incoming.slice(0, mode === 'regulars' ? MAX_QUICK_REGULARS : MAX_QUICK_ROLE).map((p, i) => ({
          ...p,
          color: PLAYER_COLORS[i % PLAYER_COLORS.length],
          rolling: [],
          windowStarts: [],
          gameDates: [],
          gameVals: [],
          lastValidIndex: -1,
          totalGames: 0,
          headshotUrl: headshotUrl(p.mlbamid),
        }))
      );
      colorIndex.current = Math.min(incoming.length, 5);
    } catch {
      setError('Failed to load team players');
    } finally {
      setQuickLoading(false);
    }
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

      // Record each player's last actual game index (used for tooltip and
      // overlay label positioning — headshot stacking is handled at render time).
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
      resetZoom();
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

  // Zoom state → filtered display data
  const isZoomed = Boolean(zoom.zoomedLeft && zoom.zoomedRight);
  const displayData = isZoomed
    ? chartData.filter(d => {
        const date = d.date as string;
        return date >= zoom.zoomedLeft! && date <= zoom.zoomedRight!;
      })
    : chartData;

  // Y-axis domain ───────────────────────────────────────────────────────────
  // When not zoomed: skip early window-filling slots + 3rd/97th percentile clip.
  // When zoomed: simple min/max of visible data so the axis tightly fits the view.
  let yMin = 0, yMax = 1;
  if (isZoomed) {
    const visVals = displayData.flatMap(d =>
      plotPlayers.map(p => d[`${p.playerid}-${p.searchType}`] as number | undefined)
    ).filter((v): v is number => v !== undefined && !isNaN(v));
    if (visVals.length) { yMin = Math.min(...visVals); yMax = Math.max(...visVals); }
  } else {
    const skipN = isCumulative
      ? Math.min(5, Math.floor(chartData.length * 0.4))
      : Math.min(rollingWindow, Math.floor(chartData.length * 0.4));
    const laterVals = chartData.slice(skipN).flatMap(d =>
      plotPlayers.map(p => d[`${p.playerid}-${p.searchType}`] as number | undefined)
    ).filter((v): v is number => v !== undefined && !isNaN(v));
    const allVals = chartData.flatMap(d =>
      plotPlayers.map(p => d[`${p.playerid}-${p.searchType}`] as number | undefined)
    ).filter((v): v is number => v !== undefined && !isNaN(v));
    const pool = laterVals.length >= 5 ? laterVals : allVals;
    const sortedPool = [...pool].sort((a, b) => a - b);
    const loIdx = Math.max(0, Math.floor(sortedPool.length * 0.03));
    const hiIdx = Math.min(sortedPool.length - 1, Math.ceil(sortedPool.length * 0.97) - 1);
    yMin = sortedPool[loIdx] ?? 0;
    yMax = sortedPool[hiIdx] ?? 1;
  }
  const yPad = (yMax - yMin) * 0.15 || 0.05;
  const yDomain: [number, number] = [
    parseFloat((yMin - yPad).toFixed(3)),
    parseFloat((yMax + yPad).toFixed(3)),
  ];

  const hasChart = displayData.length > 0 && plotPlayers.length > 0;

  // Compute display colors: team colors when every player is on a different
  // known team, otherwise fall back to the assigned palette colors.
  const chipColors = effectiveColors(selectedPlayers);
  const lineColors = effectiveColors(plotPlayers);

  const lastRow = displayData.length > 0 ? displayData[displayData.length - 1] : null;

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
                disabled={selectedPlayers.length >= MAX_PLAYERS}
                playerTypeFilter={playerType === 'hit' ? 'h' : 'p'}
                playerPool={playerPool}
                poolLoading={poolLoading}
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

          {/* Quick-add row — hitter tab only */}
          {playerType === 'hit' && (
            <div className="quick-add-row">
              <span className="control-label" style={{ whiteSpace: 'nowrap' }}>Quick Add</span>
              <select
                className="select-input"
                value={quickTeam}
                onChange={e => setQuickTeam(e.target.value)}
                disabled={quickLoading}
              >
                <option value="">— select team —</option>
                {MLB_TEAM_LIST.map(t => (
                  <option key={t.abbr} value={t.abbr}>{t.name}</option>
                ))}
              </select>
              {quickTeam && (
                <div className="quick-add-btns">
                  <button
                    className="btn-quick"
                    onClick={() => quickAdd('regulars')}
                    disabled={quickLoading}
                    title="Top 5 by plate appearances in the last ~15 team games"
                  >
                    {quickLoading ? '…' : 'Lineup Regulars'}
                  </button>
                  <button
                    className="btn-quick"
                    onClick={() => quickAdd('top5')}
                    disabled={quickLoading}
                    title={`Top 5 ${quickTeam} hitters by ${metric} this season`}
                  >
                    {quickLoading ? '…' : `Top 5 ${metric} ↑`}
                  </button>
                  <button
                    className="btn-quick"
                    onClick={() => quickAdd('bottom5')}
                    disabled={quickLoading}
                    title={`Bottom 5 ${quickTeam} hitters by ${metric} this season`}
                  >
                    {quickLoading ? '…' : `Bottom 5 ${metric} ↓`}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Player chips */}
          {selectedPlayers.length > 0 && (
            <div className="chips-row">
              {selectedPlayers.map(p => {
                const key = `${p.playerid}-${p.searchType}`;
                const clr = chipColors.get(key) ?? p.color;
                return (
                  <div key={key} className="chip" style={{ borderColor: clr }}>
                    {p.headshotUrl && (
                      <img
                        src={p.headshotUrl}
                        alt={p.name}
                        className="chip-avatar"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    )}
                    <span className="chip-dot" style={{ background: clr }} />
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
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <div className="chart-title">{chartTitle}</div>
                {isZoomed && (
                  <button className="btn-clear" style={{ fontSize: 11, padding: '2px 10px' }} onClick={resetZoom}>
                    ↩ Reset zoom
                  </button>
                )}
              </div>
              <ChartLegend players={plotPlayers} colors={lineColors} />
              <div className="chart-wrap" style={{ cursor: zoom.isSelecting ? 'col-resize' : 'crosshair' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={displayData}
                    margin={{ top: CM.top, right: CM.right, bottom: CM.bottom, left: CM.left }}
                    onMouseDown={e => {
                      const label = e?.activeLabel;
                      if (label) setZoom(z => ({ ...z, isSelecting: true, selLeft: String(label), selRight: String(label) }));
                    }}
                    onMouseMove={e => {
                      if (zoom.isSelecting && e?.activeLabel)
                        setZoom(z => ({ ...z, selRight: String(e.activeLabel) }));
                    }}
                    onMouseUp={() => {
                      // handled by window mouseup listener; just guard here
                      setZoom(z => {
                        if (z.isSelecting && z.selLeft && z.selRight && z.selLeft !== z.selRight) {
                          const [l, r] = [z.selLeft, z.selRight].sort();
                          return { isSelecting: false, selLeft: null, selRight: null, zoomedLeft: l, zoomedRight: r };
                        }
                        return { ...z, isSelecting: false, selLeft: null, selRight: null };
                      });
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#ede9e4" />
                    <XAxis
                      dataKey="date"
                      type="category"
                      ticks={pickTicks(displayData.map(d => d.date as string))}
                      tickFormatter={formatDate}
                      tick={{ fill: '#999', fontSize: 11 }}
                      stroke="#d8d5d0"
                    />
                    <YAxis
                      orientation="right"
                      width={YAXIS_W}
                      domain={yDomain}
                      tickFormatter={v => {
                        if (plotMetric.isPercent) return `${(v * 100).toFixed(plotMetric.decimals)}%`;
                        return v.toFixed(plotMetric.decimals);
                      }}
                      tick={{ fill: '#999', fontSize: 11 }}
                      stroke="#d8d5d0"
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
                          position: 'insideTopLeft',
                        }}
                      />
                    )}
                    {plotPlayers.map(player => {
                      const key = `${player.playerid}-${player.searchType}`;
                      const clr = lineColors.get(key) ?? player.color;
                      return (
                        <Line
                          key={key}
                          type="monotone"
                          dataKey={key}
                          stroke={clr}
                          strokeWidth={2.5}
                          dot={false}
                          activeDot={{ r: 4, fill: clr, stroke: '#fff', strokeWidth: 2 }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      );
                    })}
                    {/* Drag-to-zoom selection box */}
                    {zoom.isSelecting && zoom.selLeft && zoom.selRight && zoom.selLeft !== zoom.selRight && (
                      <ReferenceArea
                        x1={zoom.selLeft}
                        x2={zoom.selRight}
                        fill="#6366f1"
                        fillOpacity={0.12}
                        stroke="#6366f1"
                        strokeOpacity={0.5}
                        strokeDasharray="4 2"
                      />
                    )}
                    {/* Headshot label column — Recharts 3.x: render directly, hooks provide layout */}
                    <HeadshotLayer players={plotPlayers} lineColors={lineColors} lastRow={lastRow} />
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
