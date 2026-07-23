import { randomUUID } from "node:crypto";
import { env } from "../env";
import { fetchWithRetry } from "./retry";
import { createRedisConnection } from "../redis";

// Stated loudly, once, at module load — not left to be inferred from behavior.
// Any process that imports this file (CLI, homepage_local, or a production
// process) prints exactly which rate-limit strategy it's running, so there's
// never doubt about whether a given process is coordinating with others.
console.log(
  env.REDIS_URL
    ? "[replicate] rate limiter: DISTRIBUTED (Redis-backed, shared across every process using this account)"
    : "[replicate] rate limiter: local in-memory (no REDIS_URL — correct only if this is the sole process calling Replicate)",
);

export class ReplicateError extends Error {}

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string | null;
  // The model's own stdout. The swap model can report `status: "succeeded"`
  // with no output and only "No face found" in the logs.
  logs?: string | null;
  urls: { get: string };
}

const TERMINAL = ["succeeded", "failed", "canceled"];

// Proactive throttle on prediction STARTS (not polling — `Prefer: wait` means
// polling rarely fires). Without this, PAGE_CONCURRENCY=3 fires up to 9 hosted
// calls (repaint+swap+restore x3 pages) in a few seconds, blows past the
// account's rate limit, and every 429 pays a silent 10s+ backoff in
// fetchWithRetry — that's what stretched a ~60-75s single-page render to
// 3:44 for 3 concurrent solo pages. Spacing starts to the known limit avoids
// hitting 429 in the first place. Replicate limits per ACCOUNT, not per
// request or per process — tune via env if the account's actual limit
// differs from the documented 6/min.
const RATE_LIMIT_PER_MIN = Number(process.env.REPLICATE_RATE_LIMIT_PER_MIN ?? "6");
const RATE_LIMIT_WINDOW_MS = 60_000;

// TWO implementations, chosen once at import time:
//
//   in-memory (no REDIS_URL) — a plain array, exactly as this always worked.
//     Correct as long as ONE process makes every Replicate call, which is true
//     for the CLI and homepage_local (no queue infra, by design) and for
//     worker.ts's default STAGE_EXECUTION=direct mode.
//
//   Redis-backed (REDIS_URL set) — a sliding-window counter in a Redis sorted
//     set, checked+incremented atomically via a Lua script (EVAL is
//     single-threaded in Redis, so concurrent callers can't both slip through
//     on the same slot). REQUIRED once STAGE_EXECUTION=queued is on: repaint,
//     swap and restore then each run in their OWN process (stage-worker.ts),
//     so an in-memory counter would only ever see its own process's calls —
//     three processes each independently allowing 6/min would let up to 18/min
//     reach Replicate, the exact 429 storm this throttle exists to prevent.
//     Sharing the counter through Redis makes the limit account-wide again,
//     regardless of how many processes are making the calls.
const rateLimitWindow: number[] = []; // in-memory fallback only

let rateLimitRedis: ReturnType<typeof createRedisConnection> | undefined;
function getRateLimitRedis() {
  rateLimitRedis ??= createRedisConnection();
  return rateLimitRedis;
}

const RATE_LIMIT_KEY = "replicate:rate-limit";
// KEYS[1]=key ARGV[1]=now ARGV[2]=window ARGV[3]=limit ARGV[4]=member
// Returns 0 if a slot was acquired (and records it), otherwise the timestamp
// of the oldest call still inside the window, so the caller knows how long to
// wait before retrying.
const RATE_LIMIT_SCRIPT = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
  local count = redis.call('ZCARD', KEYS[1])
  if count < tonumber(ARGV[3]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 0
  end
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return tonumber(oldest[2])
`;

async function acquireRateLimitSlotDistributed(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const oldest = Number(
      await getRateLimitRedis().eval(
        RATE_LIMIT_SCRIPT,
        1,
        RATE_LIMIT_KEY,
        now,
        RATE_LIMIT_WINDOW_MS,
        RATE_LIMIT_PER_MIN,
        `${now}-${randomUUID()}`,
      ),
    );
    if (oldest === 0) return;
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 50;
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 50)));
  }
}

async function acquireRateLimitSlotLocal(): Promise<void> {
  for (;;) {
    const now = Date.now();
    let oldest = rateLimitWindow[0];
    while (oldest !== undefined && now - oldest >= RATE_LIMIT_WINDOW_MS) {
      rateLimitWindow.shift();
      oldest = rateLimitWindow[0];
    }
    if (rateLimitWindow.length < RATE_LIMIT_PER_MIN) {
      rateLimitWindow.push(now);
      return;
    }
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - (oldest as number)) + 50;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function acquireRateLimitSlot(): Promise<void> {
  return env.REDIS_URL ? acquireRateLimitSlotDistributed() : acquireRateLimitSlotLocal();
}

/**
 * Runs one Replicate prediction to completion and returns its output URL.
 *
 * `body` is sent as-is, so the caller decides the endpoint shape:
 *   - version-based:      path "predictions",                     body { version, input }
 *   - model-scoped:       path "models/<owner>/<name>/predictions", body { input }
 *
 * `Prefer: wait` means the common (warm) case returns without polling; the loop
 * covers cold starts. Retries (429/5xx/network) are handled by fetchWithRetry.
 *
 * `noFaceRetries` covers a different failure: the swap model can return
 * `status: "succeeded"` with no output and only "No face found" in its logs —
 * a false negative from its own face detector, not a fetchWithRetry-visible
 * HTTP error. Confirmed transient by hand: resubmitting the exact same
 * target+photo bytes that failed this way succeeded on the very next call.
 * Retrying costs one more paid prediction, so it's bounded and off by default;
 * only swapIdentity (the caller that actually sees this failure mode) opts in.
 */
export async function runReplicate(path: string, body: Record<string, unknown>, noFaceRetries = 0): Promise<string> {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) throw new ReplicateError("REPLICATE_API_TOKEN is not configured.");

  for (let attempt = 0; ; attempt += 1) {
    await acquireRateLimitSlot();
    const res = await fetchWithRetry(`https://api.replicate.com/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ReplicateError(`Replicate ${path} failed (${res.status}): ${await res.text()}`);

    let pred = (await res.json()) as Prediction;
    for (let i = 0; i < 90 && !TERMINAL.includes(pred.status); i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetchWithRetry(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } });
      pred = (await poll.json()) as Prediction;
    }

    if (pred.status !== "succeeded" || !pred.output) {
      const noFace = pred.logs?.includes("No face found") ?? false;
      if (noFace && attempt < noFaceRetries) {
        console.error(`[replicate] ${path}: model reported "No face found" (attempt ${attempt + 1}/${noFaceRetries + 1}) — retrying`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new ReplicateError(
        noFace
          ? "Couldn't find a usable face in the photo or the artwork."
          : (pred.error ?? `Replicate ${path} produced no output (status: ${pred.status}).`),
      );
    }
    const output = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!output) throw new ReplicateError(`Replicate ${path} returned an empty output.`);
    return output;
  }
}

/** Downloads a Replicate output URL to a Buffer (with the same retry policy). */
export async function fetchToBuffer(url: string): Promise<Buffer> {
  const res = await fetchWithRetry(url, {});
  if (!res.ok) throw new ReplicateError(`Failed to download Replicate output (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
