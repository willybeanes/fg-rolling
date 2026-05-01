import { NextRequest, NextResponse } from 'next/server';

// Thin proxy to FanGraphs leaderboard API.
// Forwards all query params, strips CORS restrictions, and caches at the CDN layer.
const BASE = 'https://www.fangraphs.com/api/leaders/major-league/data';

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  try {
    const res = await fetch(`${BASE}?${qs}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' },
    });
  } catch {
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 });
  }
}
