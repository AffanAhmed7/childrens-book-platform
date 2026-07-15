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

async function runStep<T>(
  sessionId: string,
  step: PipelineStep,
  action: () => Promise<T>,
): Promise<T> {
  await publishStatus(sessionId, { type: "status", step, message: STEP_MESSAGES[step] });
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await publishStatus(sessionId, { type: "error", step, message });
    await prisma.session.update({ where: { id: sessionId }, data: { status: "failed" } });
    throw error;
  }
}

async function processJob(job: Job<PipelineJobData>): Promise<void> {
  const { sessionId, rawKey } = job.data;

  await prisma.session.update({ where: { id: sessionId }, data: { status: "processing" } });

  const noBgKey = `sessions/${sessionId}/nobg.png`;
  const portraitKey = `sessions/${sessionId}/portrait.png`;

  const validation = await runStep(sessionId, "validate", () => validatePhoto(rawKey));

  await runStep(sessionId, "remove_bg", () => removeBackground(rawKey, noBgKey));
  await prisma.character.update({ where: { sessionId }, data: { noBgKey } });

  const skinToneHex = await runStep(sessionId, "skin_tone", () =>
    extractSkinTone(noBgKey, validation.faceBox),
  );
  await prisma.character.update({ where: { sessionId }, data: { skinToneHex } });

  await runStep(sessionId, "portrait", () => generatePortrait(rawKey, portraitKey));
  await prisma.character.update({ where: { sessionId }, data: { portraitKey } });

  // Compositing (Day 3) produces the final preview and publishes the `done` event.
}

export function startPipelineWorker(): Worker<PipelineJobData> {
  return new Worker<PipelineJobData>(PIPELINE_QUEUE_NAME, processJob, {
    connection: createRedisConnection(),
    concurrency: 1,
  });
}
