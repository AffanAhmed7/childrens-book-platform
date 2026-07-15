import { buildApp } from "./app";
import { env, missingDay1Config } from "./env";

const missing = missingDay1Config();
if (missing.length > 0) {
  console.warn(
    `[startup] Missing config for: ${missing.join(", ")}. Endpoints needing these will 500 until apps/api/.env is set — see .env.example.`,
  );
}

const app = await buildApp();

app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
