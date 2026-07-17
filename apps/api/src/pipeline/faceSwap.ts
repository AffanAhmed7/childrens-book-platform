import { env } from "../env";
import { createDownloadUrl } from "../storage";
import { fetchWithRetry } from "./retry";

export class FaceSwapError extends Error {}

// The engine. Replaces the previous generate-a-portrait-then-composite-it
// approach (see git history) — that fought three losing battles at once:
// diffusion drifting the child's identity, diffusion inventing the wrong pose,
// and per-template hand-tuning of the paste. This does none of that: it takes
// the illustrator's finished page and swaps the child's face onto the character
// already drawn there. Pose, angle, lighting, hair and headgear all come from
// the artwork, so they are correct by construction and need no calibration.
//
// codeplugtech/face-swap (InsightFace inswapper) — ~$0.007/run, CPU, seconds.
// Pinned to a version hash: the plain /v1/predictions endpoint requires it, and
// it stops behaviour shifting if the owner pushes an update.
//
// LICENSING: inswapper is published for non-commercial/research use; InsightFace
// sell a separate commercial licence. This is a paid product, so that needs
// resolving before launch — see PROJECT_PLAN.md.
const MODEL_VERSION = "278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string | null;
  // The model's own stdout. Absent unless something went wrong internally —
  // it can report `status: "succeeded"` with no output when its internal face
  // detector (separate from our blazeface check) fails to find a face in
  // either input, which shows up here as "No face found" rather than as
  // `error` or a non-"succeeded" status. Measured on a real photo with an
  // unusually tight/edge-to-edge crop, and separately on illustrated crops
  // whose art style the detector didn't recognize as a face at all.
  logs?: string | null;
  urls: { get: string; cancel?: string };
}

async function pollUntilDone(getUrl: string): Promise<ReplicatePrediction> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` },
    });
    if (!response.ok) {
      throw new FaceSwapError(`Replicate poll failed (${response.status}).`);
    }
    const prediction = (await response.json()) as ReplicatePrediction;
    if (prediction.status === "succeeded" || prediction.status === "failed" || prediction.status === "canceled") {
      return prediction;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new FaceSwapError("Timed out waiting for Replicate face swap.");
}

/**
 * Core swap: puts the face from `swapImageUri` onto the character drawn in
 * `targetImage`, and returns the result. Takes a buffer rather than a path so
 * callers can swap into a cropped region of a page (see personalize.ts, which
 * needs per-character targeting on multi-character pages).
 *
 * Note: this model swaps whichever face it finds — it has no face-index input.
 * On a page with several characters, always hand it a crop containing exactly
 * one of them.
 *
 * @param targetImage  the image to swap INTO (a page, or a crop of one)
 * @param swapImageUri URL or data URI of the child's photo (the face source)
 */
export async function swapFace(targetImage: Buffer, swapImageUri: string): Promise<Buffer> {
  if (!env.REPLICATE_API_TOKEN) {
    throw new FaceSwapError("REPLICATE_API_TOKEN is not configured.");
  }

  const inputImage = `data:image/png;base64,${targetImage.toString("base64")}`;
  const swapImage = swapImageUri;

  const createResponse = await fetchWithRetry("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
      // This model usually finishes inside Replicate's wait window, so the
      // common case returns the result without polling.
      Prefer: "wait",
    },
    body: JSON.stringify({
      version: MODEL_VERSION,
      input: { input_image: inputImage, swap_image: swapImage },
    }),
  });

  if (!createResponse.ok) {
    const errorBody = await createResponse.text();
    throw new FaceSwapError(`Replicate request failed (${createResponse.status}): ${errorBody}`);
  }

  let prediction = (await createResponse.json()) as ReplicatePrediction;
  if (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
    prediction = await pollUntilDone(prediction.urls.get);
  }
  if (prediction.status !== "succeeded" || !prediction.output) {
    console.error(`[faceSwap] prediction ${prediction.id} produced no output (status: ${prediction.status}). Model logs: ${prediction.logs ?? "(none)"}`);
    const noFaceFound = prediction.logs?.includes("No face found") ?? false;
    const message = noFaceFound
      ? "Couldn't find a usable face in the photo or the artwork for this page."
      : (prediction.error ?? `Face swap did not produce an image (status: ${prediction.status}).`);
    throw new FaceSwapError(message);
  }

  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!outputUrl) {
    throw new FaceSwapError("Replicate returned no output image.");
  }

  const downloadResponse = await fetchWithRetry(outputUrl, {});
  if (!downloadResponse.ok) {
    throw new FaceSwapError(`Failed to download swapped page (${downloadResponse.status}).`);
  }
  return Buffer.from(await downloadResponse.arrayBuffer());
}

// Replicate fetches the child's photo itself, so it gets a signed link rather
// than the bytes. Long-lived enough to cover a whole book's pages.
export function childPhotoUrl(rawKey: string): Promise<string> {
  return createDownloadUrl(rawKey, 3600);
}
