import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "./redis";
import { PIPELINE_QUEUE_NAME, type PipelineJobData } from "./queue";
import { prisma } from "./db";
import { publishStatus } from "./status-events";
import { STEP_MESSAGES } from "./messages";
import type { PipelineStep } from "./pipeline/types";
import { validatePhoto } from "./pipeline/validate";
import { extractSkinTone } from "./pipeline/skinTone";
import { extractHairTone } from "./pipeline/tone";
import { childPhotoUrl } from "./pipeline/faceSwap";
import { personalizePage, type CharacterInput } from "./pipeline/personalize";
import { getBook, getTone, pagesFor, pageObjectKey, type BookPage } from "./pipeline/templates";
import { mapWithConcurrency } from "./pipeline/pool";
import { createDownloadUrl, putObject, objectExists } from "./storage";

// How many pages are personalized at once. Each page may itself issue one swap
// per character, so the real ceiling on in-flight API calls is this times the
// number of children.
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY ?? "3");

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
  const tone = getTone(book);
  const pages = pagesFor(book, mode);

  const characterRows = await prisma.character.findMany({ where: { sessionId }, orderBy: { slot: "asc" } });
  if (characterRows.length === 0) {
    throw new Error(`Session ${sessionId} has no characters.`);
  }

  // Per-child prep. Photos are independent, so validate/sample them together.
  const characters: CharacterInput[] = await Promise.all(
    characterRows.map(async (character) => {
      if (!character.rawKey) {
        throw new Error(`Character ${character.id} (${character.slot}) has no uploaded photo.`);
      }
      const rawKey = character.rawKey;

      // Local face detection — no API cost — and it also confirms the photo is
      // usable before we spend anything on swaps.
      const validation = await runStep(sessionId, "validate", character.slot, () => validatePhoto(rawKey));

      // Cached across runs (the "full" run after a preview reuses it).
      let skinToneHex = character.skinToneHex;
      if (!skinToneHex) {
        skinToneHex = await runStep(sessionId, "skin_tone", character.slot, () =>
          extractSkinTone(rawKey, validation.faceBox),
        );
        await prisma.character.update({ where: { id: character.id }, data: { skinToneHex } });
      }

      // Only sampled when the hair pass is on — it's cheap, but there's no
      // reason to read the photo again for a pass that won't run.
      const hairToneHex = tone.hair ? await extractHairTone(rawKey, validation.faceBox) : null;

      return {
        slot: character.slot,
        photoUrl: await childPhotoUrl(rawKey),
        skinToneHex,
        hairToneHex,
      } satisfies CharacterInput;
    }),
  );

  await runStep(sessionId, "swap", undefined, () =>
    mapWithConcurrency(pages, PAGE_CONCURRENCY, async (page: BookPage) => {
      const key = pageObjectKey(sessionId, page.id);
      // Never pay twice for the same page: a retried job, or a "full" run after
      // a preview, reuses whatever is already rendered.
      if (await objectExists(key)) return;
      const finished = await personalizePage(page, characters, tone);
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

  const previewUrl = await createDownloadUrl(previewKey, 3600);
  await publishStatus(sessionId, { type: "done", previewUrl });
}

export function startPipelineWorker(): Worker<PipelineJobData> {
  return new Worker<PipelineJobData>(PIPELINE_QUEUE_NAME, processJob, {
    connection: createRedisConnection(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? "1"),
  });
}
