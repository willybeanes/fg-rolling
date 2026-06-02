/**
 * Fetch a FanGraphs URL via ScraperAPI to bypass Cloudflare bot detection.
 * Falls back to a direct fetch if SCRAPER_API_KEY is not set (for local dev).
 */
export async function scraperFetch(url: string, init?: RequestInit): Promise<Response> {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) {
    // Local dev fallback — direct fetch (will 403 in production without key)
    return fetch(url, init);
  }
  const proxied = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(url)}`;
  return fetch(proxied);
}
