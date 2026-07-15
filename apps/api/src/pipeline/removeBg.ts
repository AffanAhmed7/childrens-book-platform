import { env } from "../env";
import { getObjectBuffer, putObject } from "../storage";

export class RemoveBgError extends Error {}

export async function removeBackground(rawKey: string, noBgKey: string): Promise<void> {
  if (!env.REMOVEBG_API_KEY) {
    throw new RemoveBgError("REMOVEBG_API_KEY is not configured.");
  }

  const imageBuffer = await getObjectBuffer(rawKey);
  const form = new FormData();
  form.append("size", "auto");
  form.append("image_file", new Blob([imageBuffer]), "photo");

  const response = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": env.REMOVEBG_API_KEY },
    body: form,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new RemoveBgError(`remove.bg failed (${response.status}): ${errorBody}`);
  }

  const resultBuffer = Buffer.from(await response.arrayBuffer());
  await putObject(noBgKey, resultBuffer, "image/png");
}
