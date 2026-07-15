import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { env } from "./env";
import { registerSessionRoutes } from "./routes/sessions";

export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cors, { origin: env.CORS_ORIGIN });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Children's Book Platform — Prototype API",
        description:
          "Photo-to-illustration pipeline: upload, validate, generate portrait, composite preview.",
        version: "0.1.0",
      },
    },
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });

  app.get("/health", async () => ({ ok: true }));

  await registerSessionRoutes(app);

  return app;
}
