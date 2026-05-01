import { NextRequest, NextResponse } from 'next/server';

const FG_BASE = 'https://www.fangraphs.com/api/leaders/major-league/data';

// FanGraphs numeric team IDs (from their leaderboard API).
// Our UI uses standard abbreviations; some differ from FG's TeamNameAbb.
const FG_TEAM_IDS: Record<string, number> = {
  ARI: 15, ATL: 16, BAL: 2,  BOS: 3,  CHC: 17, CIN: 18, CLE: 5,
  COL: 19, CWS: 4,  DET: 6,  HOU: 21, KC:  7,  LAA: 1,  LAD: 22,
  MIA: 20, MIL: 23, MIN: 8,  NYM: 25, NYY: 9,  OAK: 10, PHI: 26,
  PIT: 27, SD:  29, SEA: 11, SF:  30, STL: 28, TB:  12, TEX: 13,
  TOR: 14, WSH: 24,
};

// Metric field names in the FG leaderboard response.
// For K%, "worst" = highest value, so bottom5 sorts descending.
const METRIC_FIELD: Record<string, string> = {
  'wOBA': 'wOBA', 'wRC+': 'wRC+', 'OBP': 'OBP', 'SLG': 'SLG',
  'BABIP': 'BABIP', 'K%': 'K%', 'BB%': 'BB%',
};
// For these metrics, a lower value is "worse" (bottom5 = highest value)
const HIGHER_IS_WORSE = new Set(['K%']);

async function fetchLeaders(params: Record<string, string | number>): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  );
  const res = await fetch(`${FG_BASE}?${qs}`, {
    headers: { Accept: 'application/json' },
    // skip next cache — responses per-team are small but the underlying
    // all-player request may be large; rely on our response Cache-Control header.
  });
  if (!res.ok) throw new Error(`FG API ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : (data?.data ?? [])) as Record<string, unknown>[];
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const team   = searchParams.get('team')   ?? '';
  const season = searchParams.get('season') ?? '2026';
  const mode   = searchParams.get('mode')   ?? 'regulars';  // regulars | top5 | bottom5
  const metric = searchParams.get('metric') ?? 'wOBA';

  if (!team) return NextResponse.json([]);

  const teamId = FG_TEAM_IDS[team];
  if (!teamId) return NextResponse.json([]);

  const sortField = METRIC_FIELD[metric] ?? 'wOBA';

  // Base params — filter to the specific team via FG's team= parameter
  const base: Record<string, string | number> = {
    pos: 'all', stats: 'bat', lg: 'all',
    qual: 0, type: 8,
    season, season1: season,
    ind: 0, pageitems: 500, pagenum: 1,
    team: teamId, rost: 0,
  };

  try {
    let rows: Record<string, unknown>[];

    if (mode === 'regulars') {
      // Approximate "last 15 team games" with a ~25-day window.
      // 25 calendar days ≈ 17-18 scheduled games accounting for off-days.
      const end   = new Date();
      const start = new Date(end);
      start.setDate(end.getDate() - 25);

      rows = await fetchLeaders({
        ...base,
        month: 1000,              // FG flag for custom date range
        startdate: isoDate(start),
        enddate:   isoDate(end),
        sortstat: 'PA', sortdir: 'desc',
      });
    } else {
      rows = await fetchLeaders({
        ...base,
        month: 0,
        sortstat: sortField,
        sortdir: mode === 'top5' ? 'desc' : 'asc',
      });
    }

    // For top/bottom 5, require a meaningful PA sample (≥ 20 PA this season)
    const qualified = mode === 'regulars'
      ? rows
      : rows.filter(r => (r.PA as number ?? 0) >= 20 && r[sortField] != null);

    // Sort
    let sorted: Record<string, unknown>[];
    if (mode === 'regulars') {
      sorted = qualified.sort((a, b) => (b.PA as number ?? 0) - (a.PA as number ?? 0));
    } else {
      const asc = mode === 'bottom5' ? !HIGHER_IS_WORSE.has(metric) : HIGHER_IS_WORSE.has(metric);
      sorted = qualified.sort((a, b) =>
        asc
          ? (a[sortField] as number ?? 0) - (b[sortField] as number ?? 0)
          : (b[sortField] as number ?? 0) - (a[sortField] as number ?? 0)
      );
    }

    const resultCount = mode === 'regulars' ? 7 : 5;
    const players = sorted.slice(0, resultCount).map(r => ({
      playerid:   String(r.playerid),
      name:       String(r.PlayerName ?? ''),
      mlbamid:    r.xMLBAMID ? Number(r.xMLBAMID) : null,
      gameLogType: 0,
      searchType: 'h',
      team,
      pos:        String(r.position ?? r.positionDB ?? ''),
    }));

    return NextResponse.json(players, {
      headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' },
    });
  } catch {
    return NextResponse.json([], { status: 502 });
  }
}
