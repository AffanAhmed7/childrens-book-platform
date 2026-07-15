import { env } from "../env";
import { createDownloadUrl, putObject } from "../storage";

export class PortraitGenerationError extends Error {}

// Default model: an InstantID wrapper that takes a plain photo + text prompt and
// handles face-embedding extraction internally (unlike the base InstantID model,
// which requires precomputing embeddings yourself — too heavy for this prototype).
// Called via Replicate's "run by name" endpoint, which uses the model's latest
// version, so no version hash needs to be pinned here. Override via
// REPLICATE_MODEL_VERSION (accepts "owner/name") if a different model is chosen
// after testing against the client's style references.
const DEFAULT_MODEL = "zsxkib/instant-id-basic";

const STYLE_PROMPT =
  "children's storybook illustration, warm watercolor style, cute cartoon character portrait, soft colors, friendly smile, high quality";
const NEGATIVE_PROMPT =
  "photorealistic, photo, realistic skin texture, blurry, extra limbs, disfigured, text, watermark";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string;
}

async function pollPrediction(id: string): Promise<ReplicatePrediction> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` },
    });
    const prediction = (await response.json()) as ReplicatePrediction;
    if (["succeeded", "failed", "canceled"].includes(prediction.status)) {
      return prediction;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new PortraitGenerationError("Timed out waiting for portrait generation.");
}

export async function generatePortrait(rawKey: string, portraitKey: string): Promise<void> {
  if (!env.REPLICATE_API_TOKEN) {
    throw new PortraitGenerationError("REPLICATE_API_TOKEN is not configured.");
  }

  // Face detection works best on the original photo (with background), not the
  // background-removed cutout, so Replicate is given a temporary signed URL to rawKey.
  const imageUrl = await createDownloadUrl(rawKey, 300);
  const model = env.REPLICATE_MODEL_VERSION ?? DEFAULT_MODEL;

  const createResponse = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        prompt: STYLE_PROMPT,
        negative_prompt: NEGATIVE_PROMPT,
      },
    }),
  });

  if (!createResponse.ok) {
    const errorBody = await createResponse.text();
    throw new PortraitGenerationError(`Replicate request failed (${createResponse.status}): ${errorBody}`);
  }

  let prediction = (await createResponse.json()) as ReplicatePrediction;
  if (prediction.status !== "succeeded") {
    prediction = await pollPrediction(prediction.id);
  }

  if (prediction.status !== "succeeded" || !prediction.output) {
    throw new PortraitGenerationError(prediction.error ?? "Portrait generation failed.");
  }

  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!outputUrl) {
    throw new PortraitGenerationError("Replicate returned no output image.");
  }
  const imageResponse = await fetch(outputUrl);
  if (!imageResponse.ok) {
    throw new PortraitGenerationError(`Failed to download generated portrait (${imageResponse.status}).`);
  }

  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  await putObject(portraitKey, buffer, "image/png");
}
