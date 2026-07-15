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
  REMOVEBG_API_KEY: readOptional("REMOVEBG_API_KEY"),
  REPLICATE_API_TOKEN: readOptional("REPLICATE_API_TOKEN"),
  REPLICATE_MODEL_VERSION: readOptional("REPLICATE_MODEL_VERSION"),
  CORS_ORIGIN: readOptional("CORS_ORIGIN") ?? "http://localhost:3000",
  PORT: Number(readOptional("PORT") ?? "3001"),
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
