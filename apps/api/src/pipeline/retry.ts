// Shared by portrait.ts and removeBg.ts — both call an external API as the
// sole implementation of a pipeline step with no fallback, so a single
// transient network blip (not a real failure) shouldn't fail the whole
// session. Retries on network errors and 5xx only; 4xx means the request
// itself is wrong and a retry won't help.
export async function fetchWithRetry(url: string, init: RequestInit, retries = 2, backoffMs = 1500): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
