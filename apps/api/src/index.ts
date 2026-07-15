import { buildApp } from "./app";
import { env, missingDay1Config } from "./env";
import { startPipelineWorker } from "./worker";

const missing = missingDay1Config();
if (missing.length > 0) {
  console.warn(
    `[startup] Missing config for: ${missing.join(", ")}. Endpoints needing these will 500 until apps/api/.env is set — see .env.example.`,
  );
}
if (!env.REDIS_URL) {
  console.warn(
    "[startup] REDIS_URL not configured — the Day 2 pipeline worker will not start; upload-confirm will skip enqueueing and /status will 503.",
  );
}

const app = await buildApp();
const worker = env.REDIS_URL ? startPipelineWorker() : undefined;

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

async function shutdown() {
  await worker?.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
