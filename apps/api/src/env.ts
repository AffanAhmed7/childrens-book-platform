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
  CORS_ORIGIN: readOptional("CORS_ORIGIN") ?? "http://localhost:3000",
  PORT: Number(readOptional("PORT") ?? "3001"),

  // Which backend runs the swap stage. `local` points at services/faceswap,
  // which runs the same inswapper model with the weights resident instead of
  // reloaded per call (~55-90s -> ~3.5s measured). Defaults to `replicate` so a
  // checkout without the local service running behaves exactly as before.
  SWAP_BACKEND: readOptional("SWAP_BACKEND") === "local" ? "local" : "replicate",
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
