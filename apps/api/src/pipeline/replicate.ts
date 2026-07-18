import { env } from "../env";
import { fetchWithRetry } from "./retry";

export class ReplicateError extends Error {}

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string | null;
  // The model's own stdout — see faceSwap.ts. The swap model can report
  // `status: "succeeded"` with no output and only "No face found" in the logs.
  logs?: string | null;
  urls: { get: string };
}

const TERMINAL = ["succeeded", "failed", "canceled"];

/**
 * Runs one Replicate prediction to completion and returns its output URL.
 *
 * `body` is sent as-is, so the caller decides the endpoint shape:
 *   - version-based:      path "predictions",                     body { version, input }
 *   - model-scoped:       path "models/<owner>/<name>/predictions", body { input }
 *
 * `Prefer: wait` means the common (warm) case returns without polling; the loop
 * covers cold starts. Retries (429/5xx/network) are handled by fetchWithRetry.
 *
 * `noFaceRetries` covers a different failure: the swap model can return
 * `status: "succeeded"` with no output and only "No face found" in its logs —
 * a false negative from its own face detector, not a fetchWithRetry-visible
 * HTTP error. Confirmed transient by hand: resubmitting the exact same
 * target+photo bytes that failed this way succeeded on the very next call.
 * Retrying costs one more paid prediction, so it's bounded and off by default;
 * only swapIdentity (the caller that actually sees this failure mode) opts in.
 */
export async function runReplicate(path: string, body: Record<string, unknown>, noFaceRetries = 0): Promise<string> {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) throw new ReplicateError("REPLICATE_API_TOKEN is not configured.");

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchWithRetry(`https://api.replicate.com/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ReplicateError(`Replicate ${path} failed (${res.status}): ${await res.text()}`);

    let pred = (await res.json()) as Prediction;
    for (let i = 0; i < 90 && !TERMINAL.includes(pred.status); i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetchWithRetry(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } });
      pred = (await poll.json()) as Prediction;
    }

    if (pred.status !== "succeeded" || !pred.output) {
      const noFace = pred.logs?.includes("No face found") ?? false;
      if (noFace && attempt < noFaceRetries) {
        console.error(`[replicate] ${path}: model reported "No face found" (attempt ${attempt + 1}/${noFaceRetries + 1}) — retrying`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new ReplicateError(
        noFace
          ? "Couldn't find a usable face in the photo or the artwork."
          : (pred.error ?? `Replicate ${path} produced no output (status: ${pred.status}).`),
      );
    }
    const output = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!output) throw new ReplicateError(`Replicate ${path} returned an empty output.`);
    return output;
  }
}

/** Downloads a Replicate output URL to a Buffer (with the same retry policy). */
export async function fetchToBuffer(url: string): Promise<Buffer> {
  const res = await fetchWithRetry(url, {});
  if (!res.ok) throw new ReplicateError(`Failed to download Replicate output (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
