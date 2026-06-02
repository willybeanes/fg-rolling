import { NextRequest, NextResponse } from 'next/server';
import { scraperFetch } from '@/lib/scraperFetch';

// ─── FanGraphs leaderboard field parsers ─────────────────────────────────────
// FG returns Name and Team as HTML anchor tags:
//   Name: <a href="statss.aspx?playerid=19556&position=DH/OF">Yordan Alvarez</a>
//   Team: <a href="...&team=21&...">HOU</a>
// xMLBAMID is the MLBAM (MLB Stats API) player ID, used for headshot URLs.
//
// FG uses non-standard abbreviations for 7 teams; we normalize to our UI abbrs:
//   CHW→CWS  KCR→KC  ATH→OAK  SDP→SD  SFG→SF  TBR→TB  WSN→WSH

const FG_ABBR_NORM: Record<string, string> = {
  CHW: 'CWS', KCR: 'KC', ATH: 'OAK', SDP: 'SD', SFG: 'SF', TBR: 'TB', WSN: 'WSH',
};

function extractText(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

function extractPlayerid(nameHtml: string): string | null {
  const m = nameHtml.match(/playerid=(\d+)/);
  return m ? m[1] : null;
}

function normTeam(raw: string): string {
  return FG_ABBR_NORM[raw] ?? raw;
}

// ─── Fetch FG leaderboard ─────────────────────────────────────────────────────

const FG_BASE = 'https://www.fangraphs.com/api/leaders/major-league/data';

async function fetchLeaders(params: Record<string, string | number>): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  );
  const res = await scraperFetch(`${FG_BASE}?${qs}`);
  if (!res.ok) throw new Error(`FG API ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data?.data ?? []);
  return rows as Record<string, unknown>[];
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const season = req.nextUrl.searchParams.get('season') ?? '2026';

  const baseParams = {
    lg: 'all', qual: 0, type: 8,
    season, season1: season,
    month: 0, ind: 0,
    pageitems: 2000000000, pagenum: 1,
  };

  try {
    const [hittersRaw, pitchersRaw] = await Promise.all([
      fetchLeaders({ ...baseParams, pos: 'all', stats: 'bat' }),
      fetchLeaders({ ...baseParams, pos: 'all', stats: 'pit' }),
    ]);

    const players: unknown[] = [];
    const hitterFgIds = new Set<string>();

    for (const raw of hittersRaw) {
      const nameHtml = String(raw.Name ?? '');
      const fgid = extractPlayerid(nameHtml);
      if (!fgid) continue;

      hitterFgIds.add(fgid);
      const mlbamid = raw.xMLBAMID ? Number(raw.xMLBAMID) : null;
      const pos = String(raw.position ?? raw.positionDB ?? '');
      const team = normTeam(raw.TeamNameAbb ? String(raw.TeamNameAbb) : extractText(String(raw.Team ?? '')));

      players.push({
        playerid: fgid,
        name: extractText(nameHtml),
        mlbamid,
        gameLogType: 0,
        searchType: 'h',
        team,
        pos,
      });
    }

    for (const raw of pitchersRaw) {
      const nameHtml = String(raw.Name ?? '');
      const fgid = extractPlayerid(nameHtml);
      if (!fgid) continue;

      const mlbamid = raw.xMLBAMID ? Number(raw.xMLBAMID) : null;
      const team = normTeam(raw.TeamNameAbb ? String(raw.TeamNameAbb) : extractText(String(raw.Team ?? '')));

      players.push({
        playerid: fgid,
        name: extractText(nameHtml),
        mlbamid,
        gameLogType: 1,
        searchType: 'p',
        team,
        pos: 'P',
      });
      // Two-way players appear in both leaderboards (hitter entry added above).
    }

    return NextResponse.json(players, {
      headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' },
    });
  } catch {
    return NextResponse.json([], { status: 502 });
  }
}
