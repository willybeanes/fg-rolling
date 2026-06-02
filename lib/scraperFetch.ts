/**
 * Fetch a FanGraphs URL via ScraperAPI to bypass Cloudflare bot detection,
 * with a Vercel KV cache (12h TTL for leaderboards, 1h for game logs).
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

  // 2. Fetch via ScraperAPI
  const key = process.env.SCRAPER_API_KEY;
  if (!key) throw new Error('SCRAPER_API_KEY not configured');
  const proxyUrl = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl);

  // 3. Cache on success (fire and forget)
  if (res.ok) {
    const clone = res.clone();
    clone.json().then((data: unknown) => kvSet(cacheKey, data, ttl)).catch(() => {});
  }

  return res;
}
