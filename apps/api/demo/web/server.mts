// Standalone demo server — feed it photos in a browser, get finished pages back.
//
//   npm run demo:web        (then open http://localhost:5174)
//
// Deliberately ISOLATED from src/app.ts (the production Fastify app). That one
// needs Postgres, Redis, BullMQ and S3 to boot; this one needs none of them, so
// a client demo can't be taken down by infrastructure that has nothing to do
// with the thing being demonstrated. It calls exactly the same pipeline
// functions the production worker calls, so what the client sees is real
// output, not a mock.
//
// Photos arrive as data URIs in a JSON body rather than multipart, because the
// pipeline already takes data URIs — that avoids adding @fastify/multipart just
// to convert one back into the other.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { SCENES, MULTI_SCENES } from "../../src/pipeline/scenes";
import { personalizeScene, personalizePage } from "../../src/pipeline/scene";
import { mapWithConcurrency } from "../../src/pipeline/pool";
import type { BookPage } from "../../src/pipeline/templates";
import type { CharacterInput } from "../../src/pipeline/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_WEB_PORT ?? 5174);

// Measured on real runs (2026-07-19), used for the countdown in the UI. Wall
// time per scene, not per stage — see docs/DEMO_RUNBOOK.md.
const ESTIMATE_SECONDS: Record<string, number> = {
  plane: 160, astronaut: 100, workshop: 95,
  mc_2: 130, mc_3: 105,
};
// Scenes run in parallel, so the wall-clock estimate is the slowest one plus a
// little slack for the others queueing behind the concurrency limit.
const CONCURRENCY = 3;

const estimateFor = (keys: string[]): number => {
  const times = keys.map((k) => ESTIMATE_SECONDS[k] ?? 120).sort((a, b) => b - a);
  const waves = Math.ceil(times.length / CONCURRENCY);
  return Math.round(times.slice(0, waves).reduce((a, b) => a + b, 0) * 1.1);
};

type Job = {
  id: string;
  mode: "single" | "multi";
  keys: string[];
  events: unknown[];
  done: boolean;
  error?: string;
  listeners: ((e: unknown) => void)[];
};
const jobs = new Map<string, Job>();

const emit = (job: Job, event: Record<string, unknown>) => {
  job.events.push(event);
  for (const l of job.listeners) l(event);
};

const dataUri = (buf: Buffer, ext = "png") => `data:image/${ext};base64,${buf.toString("base64")}`;

function decodePhoto(uri: string): { buf: Buffer; ext: "png" | "jpeg" } {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(uri);
  if (!m) throw new Error("Photo must be a PNG or JPEG data URI.");
  const ext = m[1]!.toLowerCase().startsWith("jp") ? "jpeg" : "png";
  return { buf: Buffer.from(m[2]!, "base64"), ext };
}

async function runSingle(job: Job, photoUri: string): Promise<void> {
  const { buf, ext } = decodePhoto(photoUri);
  await mapWithConcurrency(job.keys, CONCURRENCY, async (key) => {
    const started = Date.now();
    emit(job, { type: "scene-start", key });
    const scene = SCENES[key];
    if (!scene) throw new Error(`Unknown scene ${key}`);
    const out = await personalizeScene(scene, buf, ext, {
      onStage: (stage) => { emit(job, { type: "stage", key, stage }); },
    });
    emit(job, { type: "scene-done", key, image: dataUri(out), seconds: Math.round((Date.now() - started) / 1000) });
  });
}

async function runMulti(job: Job, photoUris: string[]): Promise<void> {
  // Photos map to the drawn characters left-to-right, same convention as the CLI.
  const characters: CharacterInput[] = photoUris.map((uri, i) => ({ slot: `child_${i + 1}`, photoUrl: uri }));
  await mapWithConcurrency(job.keys, CONCURRENCY, async (key) => {
    const started = Date.now();
    emit(job, { type: "scene-start", key });
    const scene = MULTI_SCENES[key];
    if (!scene) throw new Error(`Unknown multi scene ${key}`);
    const page: BookPage = {
      id: scene.id,
      imagePath: scene.imagePath,
      slots: characters.map((c) => c.slot),
      expectedCharacterCount: scene.expectedCharacterCount,
    };
    const out = await personalizePage(page, characters, {
      onStage: (stage) => { emit(job, { type: "stage", key, stage }); },
    });
    emit(job, { type: "scene-done", key, image: dataUri(out), seconds: Math.round((Date.now() - started) / 1000) });
  });
}

const app = Fastify({ bodyLimit: 40 * 1024 * 1024, logger: false });

app.get("/", async (_req, reply) => {
  reply.type("text/html").send(await readFile(path.join(HERE, "index.html"), "utf8"));
});

app.get("/api/scenes", async () => ({
  single: Object.keys(SCENES).map((k) => ({ key: k, estimate: ESTIMATE_SECONDS[k] ?? 120 })),
  multi: Object.keys(MULTI_SCENES).map((k) => ({ key: k, estimate: ESTIMATE_SECONDS[k] ?? 120 })),
}));

app.post("/api/run", async (req, reply) => {
  const body = req.body as { mode?: string; photos?: string[] };
  const mode = body.mode === "multi" ? "multi" : "single";
  const photos = Array.isArray(body.photos) ? body.photos : [];

  if (mode === "single" && photos.length !== 1) {
    return reply.code(400).send({ error: "Single-character mode needs exactly one photo." });
  }
  if (mode === "multi" && photos.length !== 2) {
    return reply.code(400).send({ error: "Multi-character mode needs exactly two photos (left, then right)." });
  }
  try {
    photos.forEach(decodePhoto);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }

  const keys = mode === "single" ? Object.keys(SCENES) : Object.keys(MULTI_SCENES);
  const job: Job = { id: Math.random().toString(36).slice(2, 10), mode, keys, events: [], done: false, listeners: [] };
  jobs.set(job.id, job);

  // Fire and forget — the browser follows progress over SSE.
  void (async () => {
    try {
      if (mode === "single") await runSingle(job, photos[0]!);
      else await runMulti(job, photos);
      emit(job, { type: "done" });
    } catch (e) {
      job.error = (e as Error).message;
      emit(job, { type: "error", message: job.error });
    } finally {
      job.done = true;
      // Give a late-connecting browser a window to drain the buffered events.
      setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000);
    }
  })();

  return { jobId: job.id, keys, estimateSeconds: estimateFor(keys) };
});

app.get("/api/run/:id/events", async (req, reply) => {
  const job = jobs.get((req.params as { id: string }).id);
  if (!job) return reply.code(404).send({ error: "Unknown job" });

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  // Replay anything that happened before this connection opened, then stream.
  for (const e of job.events) send(e);
  if (!job.done) {
    job.listeners.push(send);
    req.raw.on("close", () => {
      job.listeners = job.listeners.filter((l) => l !== send);
    });
  } else {
    reply.raw.end();
  }
});

const address = await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`\n  Demo UI running at ${address.replace("0.0.0.0", "localhost")}\n`);
