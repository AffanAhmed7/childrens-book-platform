// Every Replicate call goes through here. There is no fallback provider, so a
// single transient network blip or rate-limit must not fail a whole session —
// especially not after the expensive repaint has already been paid for.
// Retries on network errors, 5xx, and 429 — 429 means
// "slow down, try again," unlike other 4xx (which mean the request itself is
// wrong and a retry won't help). Was hit for real on a low-credit Replicate
// account (6 requests/min, burst of 1) once page concurrency issued several
// swap calls at once; Replicate's own message reports the reset is on the
// order of ~10s, well past the default backoff below, so 429 gets its own
// longer schedule.
export async function fetchWithRetry(url: string, init: RequestInit, retries = 3, backoffMs = 1500): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      if (attempt < retries) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const headerMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        const delay = Number.isFinite(headerMs)
          ? headerMs
          : response.status === 429
            ? 8000 * (attempt + 1)
            : backoffMs * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
