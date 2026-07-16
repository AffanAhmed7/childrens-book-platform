import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redis";
import { PIPELINE_QUEUE_NAME, type PipelineJobData } from "./queue";
import { prisma } from "./db";
import { publishStatus } from "./status-events";
import { STEP_MESSAGES } from "./messages";
import type { PipelineStep } from "./pipeline/types";
import { validatePhoto } from "./pipeline/validate";
import { removeBackground } from "./pipeline/removeBg";
import { extractSkinTone } from "./pipeline/skinTone";
import { generatePortrait } from "./pipeline/portrait";
import { compositeSession } from "./pipeline/composite";
import { putObject, createDownloadUrl } from "./storage";

async function runStep<T>(
  sessionId: string,
  step: PipelineStep,
  slot: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  await publishStatus(sessionId, { type: "status", step, slot, message: STEP_MESSAGES[step] });
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await publishStatus(sessionId, { type: "error", step, slot, message });
    await prisma.session.update({ where: { id: sessionId }, data: { status: "failed" } });
    throw error;
  }
}

interface CharacterRecord {
  id: string;
  slot: string;
  rawKey: string | null;
}

async function processCharacter(sessionId: string, character: CharacterRecord): Promise<void> {
  if (!character.rawKey) {
    throw new Error(`Character ${character.id} (${character.slot}) has no uploaded photo.`);
  }
  const rawKey = character.rawKey;
  const portraitKey = `sessions/${sessionId}/characters/${character.id}/portrait.png`;
  const noBgKey = `sessions/${sessionId}/characters/${character.id}/portrait-nobg.png`;

  const validation = await runStep(sessionId, "validate", character.slot, () => validatePhoto(rawKey));

  // Stylize first, then remove the background from the *generated* portrait —
  // not the raw photo — since compositing needs a transparent-background cutout
  // of the illustrated face, not the original.
  await runStep(sessionId, "portrait", character.slot, () => generatePortrait(rawKey, portraitKey));
  await prisma.character.update({ where: { id: character.id }, data: { portraitKey } });

  await runStep(sessionId, "remove_bg", character.slot, () => removeBackground(portraitKey, noBgKey));
  await prisma.character.update({ where: { id: character.id }, data: { noBgKey } });

  const skinToneHex = await runStep(sessionId, "skin_tone", character.slot, () =>
    extractSkinTone(rawKey, validation.faceBox),
  );
  await prisma.character.update({ where: { id: character.id }, data: { skinToneHex } });
}

async function processJob(job: Job<PipelineJobData>): Promise<void> {
  const { sessionId } = job.data;

  await prisma.session.update({ where: { id: sessionId }, data: { status: "processing" } });

  const characters = await prisma.character.findMany({ where: { sessionId } });

  // Sequential, not parallel: remove.bg's free tier and the shared HF Space
  // GPU queue are both easier to reason about (and less likely to collide on
  // rate limits) one character at a time for this small-scale proof.
  for (const character of characters) {
    await processCharacter(sessionId, character);
  }

  const previewBuffer = await runStep(sessionId, "composite", undefined, async () => {
    const refreshed = await prisma.character.findMany({ where: { sessionId } });
    return compositeSession(
      refreshed.map((c) => {
        if (!c.noBgKey) {
          throw new Error(`Character ${c.id} (${c.slot}) is missing its stylized portrait.`);
        }
        return { slot: c.slot, noBgKey: c.noBgKey };
      }),
    );
  });

  const previewKey = `sessions/${sessionId}/preview.png`;
  await putObject(previewKey, previewBuffer, "image/png");
  await prisma.session.update({ where: { id: sessionId }, data: { status: "done", previewKey } });

  const previewUrl = await createDownloadUrl(previewKey, 3600);
  await publishStatus(sessionId, { type: "done", previewUrl });
}

export function startPipelineWorker(): Worker<PipelineJobData> {
  return new Worker<PipelineJobData>(PIPELINE_QUEUE_NAME, processJob, {
    connection: createRedisConnection(),
    concurrency: 1,
  });
}
