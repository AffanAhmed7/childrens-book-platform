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
