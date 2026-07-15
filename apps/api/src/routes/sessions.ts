import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { prisma } from "../db";
import { createUploadUrl, rawObjectKey } from "../storage";

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

      return { ok: true as const };
    },
  );
}
