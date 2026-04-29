import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load MLBAM→FanGraphs ID mapping at startup (bundled in public/)
let mlbamToFg: Record<string, { fg: number; first: string; last: string }> | null = null;

function getMapping() {
  if (!mlbamToFg) {
    try {
      const filePath = join(process.cwd(), 'public', 'mlbam-fg-map.json');
      mlbamToFg = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      mlbamToFg = {};
    }
  }
  return mlbamToFg!;
}

// Pitcher positions in MLB Stats API
const PITCHER_POSITIONS = new Set(['P', 'SP', 'RP', 'CP', 'TWP']);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const str = searchParams.get('str') || '';

  if (!str || str.length < 2) {
    return NextResponse.json([]);
  }

  try {
    // MLB Stats API player search
    const mlbUrl = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(str)}&sportId=1&active=true&limit=20`;
    const mlbRes = await fetch(mlbUrl, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 3600 },
    });

    if (!mlbRes.ok) return NextResponse.json([]);

    const mlbData = await mlbRes.json();
    const people: any[] = mlbData?.people ?? [];

    const mapping = getMapping();
    const results: any[] = [];

    for (const person of people) {
      const mlbamid: number = person.id;
      const entry = mapping[String(mlbamid)];
      if (!entry) continue; // No FanGraphs ID found

      const pos = person.primaryPosition?.abbreviation ?? '';
      const isPitcher = PITCHER_POSITIONS.has(pos) || pos === 'TWP';
      const isTwoWay = pos === 'TWP';

      const base = {
        playerid: String(entry.fg),
        name: person.fullName,
        mlbamid,
        team: person.currentTeam?.abbreviation ?? '',
        pos,
      };

      // Two-way players (Ohtani) get two entries
      if (isTwoWay) {
        results.push({ ...base, gameLogType: 0, searchType: 'h' });
        results.push({ ...base, gameLogType: 1, searchType: 'p' });
      } else {
        results.push({
          ...base,
          gameLogType: isPitcher ? 1 : 0,
          searchType: isPitcher ? 'p' : 'h',
        });
      }
    }

    return NextResponse.json(results.slice(0, 20));
  } catch {
    return NextResponse.json([]);
  }
}
