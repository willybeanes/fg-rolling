/**
 * Fetch a FanGraphs URL — cookie auth first, ScraperAPI fallback.
 * Results are cached in Vercel KV (12h leaderboards, 1h game logs).
 */

const KV_URL   = () => process.env.KV_REST_API_URL;
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN;

async function kvGet(key: string): Promise<unknown> {
  const url = KV_URL(), token = KV_TOKEN();
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { result } = await r.json() as { result: string | null };
    return result != null ? JSON.parse(result) : null;
  } catch { return null; }
}

async function kvSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const url = KV_URL(), token = KV_TOKEN();
  if (!url || !token) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]),
    });
  } catch { /* non-fatal */ }
}

export async function scraperFetch(
  url: string,
  { ttl = 12 * 3600 }: { ttl?: number } = {}
): Promise<Response> {
  // Normalise cache key
  const parsed = new URL(url);
  const sorted = new URLSearchParams([...parsed.searchParams.entries()].sort());
  const cacheKey = `fg:${parsed.pathname}:${sorted.toString()}`;

  // 1. Try cache
  const cached = await kvGet(cacheKey);
  if (cached != null) {
    return new Response(JSON.stringify(cached), {
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
    });
  }

  const COOKIE      = process.env.FANGRAPHS_COOKIE;
  const SCRAPER_KEY = process.env.SCRAPER_API_KEY;

  // 2. Fetch — cookie auth first, ScraperAPI fallback
  let res: Response;
  if (COOKIE) {
    res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.fangraphs.com/',
        'Cookie': COOKIE,
      },
    });
    if (res.status === 403 && SCRAPER_KEY) {
      console.warn('FanGraphs cookie returned 403 — falling back to ScraperAPI');
      res = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}`);
    }
  } else if (SCRAPER_KEY) {
    res = await fetch(`https://api.scraperapi.com/?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}`);
  } else {
    throw new Error('No FANGRAPHS_COOKIE or SCRAPER_API_KEY configured');
  }

  // 3. Cache on success (fire and forget)
  if (res.ok) {
    const clone = res.clone();
    clone.json().then((data: unknown) => kvSet(cacheKey, data, ttl)).catch(() => {});
  }

  return res;
}
