import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── MLBAM → FanGraphs mapping ───────────────────────────────────────────────

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

// ─── MLB Teams ────────────────────────────────────────────────────────────────

// Each entry: MLB Stats API team ID + search terms (all lowercase)
const MLB_TEAMS: Array<{ id: number; abbr: string; terms: string[] }> = [
  // AL East
  { id: 110, abbr: 'BAL', terms: ['baltimore', 'orioles', 'bal', 'o\'s', 'os'] },
  { id: 111, abbr: 'BOS', terms: ['boston', 'red sox', 'redsox', 'bos'] },
  { id: 147, abbr: 'NYY', terms: ['new york yankees', 'yankees', 'nyy', 'ny yankees'] },
  { id: 139, abbr: 'TB',  terms: ['tampa bay', 'rays', 'tb', 'tampa'] },
  { id: 141, abbr: 'TOR', terms: ['toronto', 'blue jays', 'bluejays', 'jays', 'tor'] },
  // AL Central
  { id: 145, abbr: 'CWS', terms: ['chicago white sox', 'white sox', 'whitesox', 'cws', 'chisox'] },
  { id: 114, abbr: 'CLE', terms: ['cleveland', 'guardians', 'cle'] },
  { id: 116, abbr: 'DET', terms: ['detroit', 'tigers', 'det'] },
  { id: 118, abbr: 'KC',  terms: ['kansas city', 'royals', 'kc'] },
  { id: 142, abbr: 'MIN', terms: ['minnesota', 'twins', 'min'] },
  // AL West
  { id: 117, abbr: 'HOU', terms: ['houston', 'astros', 'hou'] },
  { id: 108, abbr: 'LAA', terms: ['los angeles angels', 'angels', 'laa', 'la angels', 'anaheim'] },
  { id: 133, abbr: 'OAK', terms: ['oakland', 'athletics', 'oak', "a's", 'as'] },
  { id: 136, abbr: 'SEA', terms: ['seattle', 'mariners', 'sea', 'm\'s', 'ms'] },
  { id: 140, abbr: 'TEX', terms: ['texas', 'rangers', 'tex'] },
  // NL East
  { id: 144, abbr: 'ATL', terms: ['atlanta', 'braves', 'atl'] },
  { id: 146, abbr: 'MIA', terms: ['miami', 'marlins', 'mia'] },
  { id: 121, abbr: 'NYM', terms: ['new york mets', 'mets', 'nym', 'ny mets'] },
  { id: 143, abbr: 'PHI', terms: ['philadelphia', 'phillies', 'phi', 'phils'] },
  { id: 120, abbr: 'WSH', terms: ['washington', 'nationals', 'wsh', 'nats'] },
  // NL Central
  { id: 112, abbr: 'CHC', terms: ['chicago cubs', 'cubs', 'chc'] },
  { id: 113, abbr: 'CIN', terms: ['cincinnati', 'reds', 'cin'] },
  { id: 158, abbr: 'MIL', terms: ['milwaukee', 'brewers', 'mil'] },
  { id: 134, abbr: 'PIT', terms: ['pittsburgh', 'pirates', 'pit', 'bucs'] },
  { id: 138, abbr: 'STL', terms: ['st. louis', 'st louis', 'cardinals', 'stl', 'cards'] },
  // NL West
  { id: 109, abbr: 'ARI', terms: ['arizona', 'diamondbacks', 'd-backs', 'dbacks', 'ari'] },
  { id: 115, abbr: 'COL', terms: ['colorado', 'rockies', 'col', 'rox'] },
  { id: 119, abbr: 'LAD', terms: ['los angeles dodgers', 'dodgers', 'lad', 'la dodgers'] },
  { id: 135, abbr: 'SD',  terms: ['san diego', 'padres', 'sd'] },
  { id: 137, abbr: 'SF',  terms: ['san francisco', 'giants', 'sf'] },
];

// Returns the first team whose terms include the query as a prefix (min 3 chars)
function matchTeam(query: string): typeof MLB_TEAMS[number] | null {
  if (query.length < 3) return null;
  const q = query.toLowerCase().trim();
  for (const team of MLB_TEAMS) {
    for (const term of team.terms) {
      if (term.startsWith(q) || term === q) return team;
    }
  }
  return null;
}

// ─── Pitcher positions ────────────────────────────────────────────────────────

const PITCHER_POSITIONS = new Set(['P', 'SP', 'RP', 'CP', 'TWP']);

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const str = searchParams.get('str') || '';
  const season = searchParams.get('season') || '2026';

  if (!str || str.length < 2) return NextResponse.json([]);

  try {
    const mapping = getMapping();

    // ── Team roster lookup ──────────────────────────────────────────────────
    const team = matchTeam(str);
    if (team) {
      const rosterUrl = `https://statsapi.mlb.com/api/v1/teams/${team.id}/roster?rosterType=fullSeason&season=${season}`;
      const rosterRes = await fetch(rosterUrl, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 3600 },
      });
      if (!rosterRes.ok) return NextResponse.json([]);

      const rosterData = await rosterRes.json();
      const roster: any[] = rosterData?.roster ?? [];

      const results: any[] = [];
      for (const member of roster) {
        const mlbamid: number = member.person?.id;
        if (!mlbamid) continue;
        const entry = mapping[String(mlbamid)];
        if (!entry) continue;

        const pos = member.position?.abbreviation ?? '';
        const isPitcher = PITCHER_POSITIONS.has(pos);
        const isTwoWay = pos === 'TWP';
        const fullName = member.person?.fullName ?? `${entry.first} ${entry.last}`;

        const base = {
          playerid: String(entry.fg),
          name: fullName,
          mlbamid,
          team: team.abbr,
          pos,
        };

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

      // Sort alphabetically by last name
      results.sort((a, b) => {
        const aLast = a.name.split(' ').slice(-1)[0];
        const bLast = b.name.split(' ').slice(-1)[0];
        return aLast.localeCompare(bLast);
      });

      return NextResponse.json(results);
    }

    // ── Player name search ──────────────────────────────────────────────────
    const mlbUrl = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(str)}&sportId=1&active=true&limit=20`;
    const mlbRes = await fetch(mlbUrl, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    });

    if (!mlbRes.ok) return NextResponse.json([]);

    const mlbData = await mlbRes.json();
    const people: any[] = mlbData?.people ?? [];

    const results: any[] = [];
    for (const person of people) {
      const mlbamid: number = person.id;
      const entry = mapping[String(mlbamid)];
      if (!entry) continue;

      const pos = person.primaryPosition?.abbreviation ?? '';
      const isPitcher = PITCHER_POSITIONS.has(pos);
      const isTwoWay = pos === 'TWP';

      const base = {
        playerid: String(entry.fg),
        name: person.fullName,
        mlbamid,
        team: person.currentTeam?.abbreviation ?? '',
        pos,
      };

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
