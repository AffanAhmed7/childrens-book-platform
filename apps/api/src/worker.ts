import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redis";
import { PIPELINE_QUEUE_NAME, type PipelineJobData } from "./queue";
import { prisma } from "./db";
import { publishStatus } from "./status-events";
import { STEP_MESSAGES, STAGE_MESSAGES } from "./messages";
import type { CharacterInput, PipelineStep } from "./pipeline/types";
import { validatePhoto } from "./pipeline/validate";
import { personalizePage } from "./pipeline/personalize";
import { getBook, pagesFor, pageObjectKey, type Page } from "./pipeline/catalog";
import { mapWithConcurrency } from "./pipeline/pool";
import { createDownloadUrl, putObject, objectExists } from "./storage";
import { warmFaceDetector } from "./pipeline/faceDetect";

// How many pages are personalized at once. Each page may itself issue one
// repaint+swap per character, so the real ceiling on in-flight API calls is this
// times the number of children.
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY ?? "3");

// Replicate fetches the child's photo itself, so it gets a signed link rather
// than the bytes. Long-lived enough to cover a whole book's pages.
const PHOTO_URL_TTL_SECONDS = 3600;

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
    // A generic message like "fetch failed" hides the actual cause (ECONNRESET,
    // ETIMEDOUT, DNS failure, etc.) — log the full error so a failure can be
    // diagnosed from server logs alone, without needing to reproduce it.
    console.error(`[worker] step "${step}" (slot: ${slot ?? "-"}) failed for session ${sessionId}:`, error);
    await publishStatus(sessionId, { type: "error", step, slot, message });
    await prisma.session.update({ where: { id: sessionId }, data: { status: "failed" } });
    throw error;
  }
}

async function processJob(job: Job<PipelineJobData>): Promise<void> {
  const { sessionId, mode } = job.data;

  const session = await prisma.session.update({
    where: { id: sessionId },
    data: { status: "processing" },
  });
  const book = getBook(session.storyId);
  const pages = pagesFor(book, mode);

  const characterRows = await prisma.character.findMany({ where: { sessionId }, orderBy: { slot: "asc" } });
  if (characterRows.length === 0) {
    throw new Error(`Session ${sessionId} has no characters.`);
  }

  // Per-child prep. Photos are independent, so validate them together.
  const characters: CharacterInput[] = await Promise.all(
    characterRows.map(async (character) => {
      if (!character.rawKey) {
        throw new Error(`Character ${character.id} (${character.slot}) has no uploaded photo.`);
      }
      const rawKey = character.rawKey;

      // Local face detection — no API cost — and it confirms the photo is usable
      // before we spend anything on rendering.
      await runStep(sessionId, "validate", character.slot, () => validatePhoto(rawKey));

      return {
        slot: character.slot,
        photoUrl: await createDownloadUrl(rawKey, PHOTO_URL_TTL_SECONDS),
      } satisfies CharacterInput;
    }),
  );

  await runStep(sessionId, "render", undefined, () =>
    mapWithConcurrency(pages, PAGE_CONCURRENCY, async (page: Page) => {
      const key = pageObjectKey(sessionId, page.id);
      // Never pay twice for the same page: a retried job, or a "full" run after
      // a preview, reuses whatever is already rendered.
      if (await objectExists(key)) return;
      await publishStatus(sessionId, { type: "status", step: "render", page: page.id, message: "Starting…" });
      const finished = await personalizePage(page, characters, {
        onStage: (stage) =>
          publishStatus(sessionId, { type: "status", step: "render", page: page.id, stage, message: STAGE_MESSAGES[stage] }),
      });
      await putObject(key, finished, "image/png");
    }),
  );

  const firstPage = pages[0];
  if (!firstPage) {
    throw new Error(`Book "${session.storyId}" has no pages to render for mode "${mode}".`);
  }
  const previewKey = pageObjectKey(sessionId, firstPage.id);
  await prisma.session.update({
    where: { id: sessionId },
    data: { status: "done", previewKey },
  });

  const previewUrl = await createDownloadUrl(previewKey, PHOTO_URL_TTL_SECONDS);
  await publishStatus(sessionId, { type: "done", previewUrl });
}

export function startPipelineWorker(): Worker<PipelineJobData> {
  // Fire-and-forget: loads the blazeface model now so the first real job
  // doesn't pay the ~5-13s one-time load cost. Safe to not await — any job
  // that starts before this resolves just shares the same in-flight promise
  // (see getModel in faceDetect.ts), it never loads twice.
  void warmFaceDetector();
  return new Worker<PipelineJobData>(PIPELINE_QUEUE_NAME, processJob, {
    connection: createRedisConnection(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? "1"),
  });
}
