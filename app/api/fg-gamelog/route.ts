import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const playerid = searchParams.get('playerid');
  const type = searchParams.get('type') || '0';
  const season = searchParams.get('season') || '2026';

  if (!playerid) {
    return NextResponse.json({ error: 'Missing playerid' }, { status: 400 });
  }

  const url = `https://www.fangraphs.com/api/players/game-log?playerid=${playerid}&position=&type=${type}&z=${season}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FGRolling/1.0)' },
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `FanGraphs returned ${res.status}` }, { status: res.status });
    }

    const data = await res.json();

    // FanGraphs returns { mlb: [...] } for individual game logs
    // Filter out the aggregate row (FanGraphs uses date 2050-01-01 as a sentinel)
    // and reverse so games are in chronological order (oldest first)
    const rawGames: Record<string, unknown>[] = Array.isArray(data)
      ? data
      : (data?.mlb ?? data?.mlbgamelogs ?? data?.gamelogs ?? data?.data ?? []);

    const games = rawGames
      .filter(g => {
        const d = String(g?.Date ?? '');
        return !d.includes('2050');
      })
      .reverse(); // FG returns newest-first; we want oldest-first for rolling calc

    return NextResponse.json(games);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch game log' }, { status: 500 });
  }
}
