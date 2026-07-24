import dotenv from "dotenv";

dotenv.config();

function readOptional(key: string): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

export const env = {
  DATABASE_URL: readOptional("DATABASE_URL"),
  R2_ACCOUNT_ID: readOptional("R2_ACCOUNT_ID"),
  R2_ACCESS_KEY_ID: readOptional("R2_ACCESS_KEY_ID"),
  R2_SECRET_ACCESS_KEY: readOptional("R2_SECRET_ACCESS_KEY"),
  R2_BUCKET_NAME: readOptional("R2_BUCKET_NAME"),
  REDIS_URL: readOptional("REDIS_URL"),
  REPLICATE_API_TOKEN: readOptional("REPLICATE_API_TOKEN"),
  // Second Replicate account, used as an immediate-switch fallback (not a
  // patient retry) the moment the primary account gets rate-limited — see
  // replicate.ts's acquireAccount/fetchReplicateWithAccountFallback. Optional:
  // with this unset, behavior is identical to before (one account, waits out
  // its own rate limit as it always did).
  REPLICATE_API_TOKEN_FALLBACK: readOptional("REPLICATE_API_TOKEN_FALLBACK"),
  // Comma-separated so the homepage (its own origin, :5174) and any future
  // deployed frontend can both be allowed without editing code per-origin.
  CORS_ORIGIN: (readOptional("CORS_ORIGIN") ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  PORT: Number(readOptional("PORT") ?? "3001"),

  // Which backend runs the swap stage:
  //   replicate (default) — hosted only. A checkout without the local service
  //                         running behaves exactly as before.
  //   local               — local only (services/faceswap). Errors if the
  //                         service is down. For testing the local path alone.
  //   auto                — try local first, fall back to hosted on any failure.
  //                         The production-resilient mode: fast when the box is
  //                         healthy, degrades to slow-but-working when it isn't.
  SWAP_BACKEND: (() => {
    const v = readOptional("SWAP_BACKEND");
    return v === "local" || v === "auto" ? v : "replicate";
  })(),
  SWAP_LOCAL_URL: readOptional("SWAP_LOCAL_URL") ?? "http://127.0.0.1:5175",

  // Which of the 5 pipeline stages (repaint/swap/restore/heal/eyes) actually
  // run in-process vs. as their own BullMQ job on their own queue:
  //   direct (default) — worker.ts calls each stage function itself, in-process.
  //                       Zero extra setup; what the CLI and homepage_local always do.
  //   queued            — each stage is enqueued to its own queue and awaited via
  //                       BullMQ, consumed by dedicated stage-worker.ts processes
  //                       (npm run stage:repaint / stage:swap / ...). Requires those
  //                       processes to be running or a session's render hangs
  //                       waiting for a stage that never gets picked up.
  // See docs/INFRA_AND_PIPELINE_TRACE.md for why this split exists.
  STAGE_EXECUTION: (() => {
    const v = readOptional("STAGE_EXECUTION");
    return v === "queued" ? "queued" : "direct";
  })(),
};

const DAY1_REQUIRED_KEYS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
] as const;

export function missingDay1Config(): string[] {
  return DAY1_REQUIRED_KEYS.filter((key) => !env[key]);
}
