import sharp from "sharp";
import { Agent, fetch as undiciFetch } from "undici";
import { getObjectBuffer, putObject } from "../storage";

export class PortraitGenerationError extends Error {}

// Free (no card, no payment) alternative to a paid API: a public Hugging Face
// Space running InstantID, called via Gradio's HTTP API. Trade-off vs a paid
// service like Replicate: this runs on HF's shared free GPU queue, so latency is
// less predictable — observed anywhere from a few seconds to several minutes
// under load — and it's a community-maintained demo that could change or go
// down without notice. If reliability becomes a problem, swap back to a paid
// model (see git history for the Replicate-based version of this file).
const SPACE_BASE_URL = "https://instantx-instantid.hf.space";

// Node's default fetch (undici) aborts a response body after 5 minutes of
// inactivity (UND_ERR_BODY_TIMEOUT) — too short for this queue's observed
// latency. The long-poll result stream uses undici's fetch directly with a
// generous timeout instead of the global one.
const longPollAgent = new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 });
const STYLE_TEMPLATE = "Watercolor"; // one of the space's built-in style presets

const STYLE_PROMPT =
  "children's storybook illustration, warm watercolor style, cute cartoon character portrait, soft colors, friendly smile";
// The space's own tuned negative prompt (from its default UI value) — reused
// as-is since it's already calibrated for this specific model.
const NEGATIVE_PROMPT =
  "(lowres, low quality, worst quality:1.2), (text:1.2), watermark, (frame:1.2), deformed, ugly, " +
  "deformed eyes, blur, out of focus, blurry, deformed cat, deformed, photo, anthropomorphic cat, " +
  "monochrome, pet collar, gun, weapon, blue, 3d, drones, drone, buildings in background, green";

interface GradioFileData {
  path: string;
  meta: { _type: "gradio.FileData" };
}

async function uploadToSpace(buffer: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([buffer]), filename);

  const response = await fetch(`${SPACE_BASE_URL}/upload`, { method: "POST", body: form });
  if (!response.ok) {
    throw new PortraitGenerationError(`Hugging Face Space upload failed (${response.status}).`);
  }
  const [uploadedPath] = (await response.json()) as string[];
  if (!uploadedPath) {
    throw new PortraitGenerationError("Hugging Face Space upload returned no file path.");
  }
  return uploadedPath;
}

// Exact positional order required by the Space's `generate_image` API — verified
// against its live /config schema (dependency inputs: [6,7,8,20,11,21,12,13,16,
// 17,15,22,23,24,10,26]). Gradio's call API takes no partial defaults: every
// input must be supplied explicitly, in this order, on every call.
function buildCallPayload(faceImage: GradioFileData): unknown[] {
  return [
    faceImage,
    null, // optional reference pose image — unused
    STYLE_PROMPT,
    NEGATIVE_PROMPT,
    STYLE_TEMPLATE,
    30, // sample steps
    0.8, // IdentityNet strength
    0.8, // image adapter strength
    0.4, // canny strength
    0.4, // depth strength
    ["depth"], // controlnet
    5, // guidance scale
    Math.floor(Math.random() * 1_000_000), // seed — randomized per call for variety
    "EulerDiscreteScheduler",
    false, // fast inference (LCM)
    true, // enhance non-face region
  ];
}

async function pollForResult(eventId: string): Promise<GradioFileData> {
  const response = await undiciFetch(`${SPACE_BASE_URL}/call/generate_image/${eventId}`, {
    headers: { Accept: "text/event-stream" },
    dispatcher: longPollAgent,
  });
  if (!response.ok || !response.body) {
    throw new PortraitGenerationError(`Failed to open Hugging Face Space result stream (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const eventLine = frame.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      const eventName = eventLine?.slice("event:".length).trim();

      if (eventName === "error") {
        throw new PortraitGenerationError(`Portrait generation failed: ${dataLine ?? "unknown error"}`);
      }
      if (eventName === "complete" && dataLine) {
        const payload = JSON.parse(dataLine.slice("data:".length).trim()) as [GradioFileData, unknown];
        const [image] = payload;
        if (!image?.path) {
          throw new PortraitGenerationError("Hugging Face Space returned no generated image.");
        }
        return image;
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }

  throw new PortraitGenerationError("Hugging Face Space result stream ended without a result.");
}

export async function generatePortrait(rawKey: string, portraitKey: string): Promise<void> {
  // Face detection works best on the original photo (with background), not the
  // background-removed cutout, so the raw upload is sent, not the no-bg version.
  const rawBuffer = await getObjectBuffer(rawKey);
  const uploadedPath = await uploadToSpace(rawBuffer, "photo.jpg");

  const faceImage: GradioFileData = { path: uploadedPath, meta: { _type: "gradio.FileData" } };

  const callResponse = await fetch(`${SPACE_BASE_URL}/call/generate_image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: buildCallPayload(faceImage) }),
  });
  if (!callResponse.ok) {
    const errorBody = await callResponse.text();
    throw new PortraitGenerationError(`Hugging Face Space call failed (${callResponse.status}): ${errorBody}`);
  }
  const { event_id: eventId } = (await callResponse.json()) as { event_id: string };

  const resultImage = await pollForResult(eventId);

  const downloadResponse = await fetch(`${SPACE_BASE_URL}/file=${resultImage.path}`);
  if (!downloadResponse.ok) {
    throw new PortraitGenerationError(`Failed to download generated portrait (${downloadResponse.status}).`);
  }
  const resultBuffer = Buffer.from(await downloadResponse.arrayBuffer());

  // Normalize to PNG (the Space returns webp) to match this project's portraitKey convention.
  const pngBuffer = await sharp(resultBuffer).png().toBuffer();
  await putObject(portraitKey, pngBuffer, "image/png");
}
