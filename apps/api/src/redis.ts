import { Redis } from "ioredis";
import { env } from "./env";

export function createRedisConnection(): Redis {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is not configured.");
  }
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // Without a listener, ioredis re-throws connection errors as uncaught
  // exceptions (Node's default EventEmitter behavior for unhandled "error"
  // events) — a single transient network blip on any connection (e.g. one
  // SSE subscriber) would otherwise crash the entire server process.
  connection.on("error", (error) => {
    console.error("[redis] connection error:", error.message);
  });
  return connection;
}
