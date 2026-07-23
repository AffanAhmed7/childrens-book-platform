// Every Replicate call goes through here. There is no fallback provider, so a
// single transient network blip or rate-limit must not fail a whole session —
// especially not after the expensive repaint has already been paid for.
// Retries on network errors, 5xx, and 429 — 429 means
// "slow down, try again," unlike other 4xx (which mean the request itself is
// wrong and a retry won't help). Was hit for real on a low-credit Replicate
// account (6 requests/min, burst of 1) once page concurrency issued several
// swap calls at once. 429s aren't billed, so they get a much bigger retry
// budget than the generic one (RATE_LIMIT_RETRIES, independent of `retries`)
// plus random jitter — without jitter, several pages that all started backing
// off in the same window retry on the exact same schedule and re-collide on
// the next attempt instead of spreading out enough for the bucket to refill.
const RATE_LIMIT_RETRIES = 6;

export async function fetchWithRetry(url: string, init: RequestInit, retries = 3, backoffMs = 1500): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      continue;
    }
    if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
      return response;
    }
    const limit = response.status === 429 ? Math.max(retries, RATE_LIMIT_RETRIES) : retries;
    lastError = new Error(`HTTP ${response.status}`);
    if (attempt >= limit) throw lastError;
    const retryAfterHeader = response.headers.get("Retry-After");
    const headerMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
    const delay = Number.isFinite(headerMs)
      ? headerMs
      : response.status === 429
        ? 10000 * (attempt + 1) + Math.random() * 2000
        : backoffMs * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
