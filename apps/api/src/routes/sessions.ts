import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../db";
import { env } from "../env";
import { createUploadUrl, rawObjectKey } from "../storage";
import { getPipelineQueue } from "../queue";
import { subscribeStatus } from "../status-events";

const ErrorResponse = Type.Object({ message: Type.String() });

const CreateSessionBody = Type.Object({
  locale: Type.Optional(Type.String({ default: "fr" })),
  storyId: Type.String({ minLength: 1 }),
  childName: Type.String({ minLength: 1, maxLength: 100 }),
});
const CreateSessionResponse = Type.Object({ sessionId: Type.String() });

const SessionParams = Type.Object({ id: Type.String({ format: "uuid" }) });

const UploadUrlBody = Type.Object({
  contentType: Type.Union([
    Type.Literal("image/jpeg"),
    Type.Literal("image/png"),
    Type.Literal("image/webp"),
  ]),
});
const UploadUrlResponse = Type.Object({
  uploadUrl: Type.String(),
  objectKey: Type.String(),
});

const UploadConfirmBody = Type.Object({ objectKey: Type.String({ minLength: 1 }) });
const UploadConfirmResponse = Type.Object({ ok: Type.Literal(true) });

const CharacterView = Type.Object({
  id: Type.String(),
  rawKey: Type.Union([Type.String(), Type.Null()]),
  noBgKey: Type.Union([Type.String(), Type.Null()]),
  skinToneHex: Type.Union([Type.String(), Type.Null()]),
  portraitKey: Type.Union([Type.String(), Type.Null()]),
  previewKey: Type.Union([Type.String(), Type.Null()]),
});
const SessionView = Type.Object({
  id: Type.String(),
  locale: Type.String(),
  storyId: Type.String(),
  childName: Type.String(),
  status: Type.String(),
  createdAt: Type.String(),
  character: Type.Union([CharacterView, Type.Null()]),
});

export async function registerSessionRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.post(
    "/api/sessions",
    {
      schema: {
        tags: ["sessions"],
        body: CreateSessionBody,
        response: { 201: CreateSessionResponse },
      },
    },
    async (request, reply) => {
      const { locale, storyId, childName } = request.body;
      const session = await prisma.session.create({
        data: { locale: locale ?? "fr", storyId, childName },
      });
      reply.code(201);
      return { sessionId: session.id };
    },
  );

  api.get(
    "/api/sessions/:id",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        response: { 200: SessionView, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const session = await prisma.session.findUnique({
        where: { id: request.params.id },
        include: { character: true },
      });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }
      return { ...session, createdAt: session.createdAt.toISOString() };
    },
  );

  api.post(
    "/api/sessions/:id/upload-url",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        body: UploadUrlBody,
        response: { 200: UploadUrlResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { contentType } = request.body;

      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }

      const objectKey = rawObjectKey(id, contentType);
      const uploadUrl = await createUploadUrl(objectKey, contentType, 60);

      return { uploadUrl, objectKey };
    },
  );

  api.post(
    "/api/sessions/:id/upload-confirm",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        body: UploadConfirmBody,
        response: { 200: UploadConfirmResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { objectKey } = request.body;

      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }

      await prisma.character.upsert({
        where: { sessionId: id },
        create: { sessionId: id, rawKey: objectKey },
        update: { rawKey: objectKey },
      });
      await prisma.session.update({ where: { id }, data: { status: "uploaded" } });

      if (env.REDIS_URL) {
        const job = await getPipelineQueue().add(
          "process",
          { sessionId: id, rawKey: objectKey },
          { attempts: 1, removeOnComplete: true, removeOnFail: false },
        );
        await prisma.character.update({ where: { sessionId: id }, data: { jobId: job.id } });
      } else {
        request.log.warn("REDIS_URL not configured — skipping Day 2 pipeline enqueue.");
      }

      return { ok: true as const };
    },
  );

  api.get(
    "/api/sessions/:id/status",
    {
      schema: {
        tags: ["sessions"],
        params: SessionParams,
        response: { 404: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }
      if (!env.REDIS_URL) {
        return reply
          .code(503)
          .send({ message: "Live status streaming is not configured yet (REDIS_URL missing)." });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const send = (eventName: string, data: unknown) => {
        reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        void unsubscribe();
        reply.raw.end();
      };

      const unsubscribe = subscribeStatus(id, (event) => {
        if (event.type === "status") {
          send("status", { step: event.step, message: event.message });
        } else if (event.type === "done") {
          send("done", { previewUrl: event.previewUrl });
          cleanup();
        } else if (event.type === "error") {
          send("error", { step: event.step, message: event.message });
          cleanup();
        }
      });

      request.raw.on("close", cleanup);
    },
  );
}
