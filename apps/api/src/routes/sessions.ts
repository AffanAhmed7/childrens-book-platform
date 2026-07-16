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
  characters: Type.Array(
    Type.Object({
      slot: Type.String({ minLength: 1 }),
      childName: Type.String({ minLength: 1, maxLength: 100 }),
    }),
    { minItems: 1 },
  ),
});
const CreateSessionResponse = Type.Object({
  sessionId: Type.String(),
  characters: Type.Array(
    Type.Object({ characterId: Type.String(), slot: Type.String(), childName: Type.String() }),
  ),
});

const SessionParams = Type.Object({ id: Type.String({ format: "uuid" }) });
const CharacterParams = Type.Object({
  id: Type.String({ format: "uuid" }),
  characterId: Type.String({ format: "uuid" }),
});

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
const UploadConfirmResponse = Type.Object({ ok: Type.Literal(true), allUploaded: Type.Boolean() });

const CharacterView = Type.Object({
  id: Type.String(),
  slot: Type.String(),
  childName: Type.String(),
  rawKey: Type.Union([Type.String(), Type.Null()]),
  noBgKey: Type.Union([Type.String(), Type.Null()]),
  skinToneHex: Type.Union([Type.String(), Type.Null()]),
  portraitKey: Type.Union([Type.String(), Type.Null()]),
});
const SessionView = Type.Object({
  id: Type.String(),
  locale: Type.String(),
  storyId: Type.String(),
  status: Type.String(),
  createdAt: Type.String(),
  previewKey: Type.Union([Type.String(), Type.Null()]),
  characters: Type.Array(CharacterView),
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
      const { locale, storyId, characters } = request.body;
      const session = await prisma.session.create({
        data: {
          locale: locale ?? "fr",
          storyId,
          characters: { create: characters.map((c) => ({ slot: c.slot, childName: c.childName })) },
        },
        include: { characters: true },
      });
      reply.code(201);
      return {
        sessionId: session.id,
        characters: session.characters.map((c) => ({
          characterId: c.id,
          slot: c.slot,
          childName: c.childName,
        })),
      };
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
        include: { characters: true },
      });
      if (!session) {
        return reply.code(404).send({ message: "Session not found" });
      }
      return { ...session, createdAt: session.createdAt.toISOString() };
    },
  );

  api.post(
    "/api/sessions/:id/characters/:characterId/upload-url",
    {
      schema: {
        tags: ["sessions"],
        params: CharacterParams,
        body: UploadUrlBody,
        response: { 200: UploadUrlResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id, characterId } = request.params;
      const { contentType } = request.body;

      const character = await prisma.character.findFirst({ where: { id: characterId, sessionId: id } });
      if (!character) {
        return reply.code(404).send({ message: "Character not found" });
      }

      const objectKey = rawObjectKey(id, characterId, contentType);
      const uploadUrl = await createUploadUrl(objectKey, contentType, 60);

      return { uploadUrl, objectKey };
    },
  );

  api.post(
    "/api/sessions/:id/characters/:characterId/upload-confirm",
    {
      schema: {
        tags: ["sessions"],
        params: CharacterParams,
        body: UploadConfirmBody,
        response: { 200: UploadConfirmResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { id, characterId } = request.params;
      const { objectKey } = request.body;

      const character = await prisma.character.findFirst({ where: { id: characterId, sessionId: id } });
      if (!character) {
        return reply.code(404).send({ message: "Character not found" });
      }

      await prisma.character.update({ where: { id: characterId }, data: { rawKey: objectKey } });

      const remaining = await prisma.character.count({ where: { sessionId: id, rawKey: null } });
      const allUploaded = remaining === 0;

      if (allUploaded) {
        await prisma.session.update({ where: { id }, data: { status: "uploaded" } });

        if (env.REDIS_URL) {
          const job = await getPipelineQueue().add(
            "process",
            { sessionId: id },
            { attempts: 1, removeOnComplete: true, removeOnFail: false },
          );
          await prisma.character.updateMany({ where: { sessionId: id }, data: { jobId: job.id } });
        } else {
          request.log.warn("REDIS_URL not configured — skipping pipeline enqueue.");
        }
      }

      return { ok: true as const, allUploaded };
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
          send("status", { step: event.step, slot: event.slot, message: event.message });
        } else if (event.type === "done") {
          send("done", { previewUrl: event.previewUrl });
          cleanup();
        } else if (event.type === "error") {
          send("error", { step: event.step, slot: event.slot, message: event.message });
          cleanup();
        }
      });

      request.raw.on("close", cleanup);
    },
  );
}
