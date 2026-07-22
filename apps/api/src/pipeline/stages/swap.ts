import { runReplicate, fetchToBuffer, ReplicateError } from "../replicate";
import { dataUri } from "../dataUri";
import { env } from "../../env";

// STAGE 2 of 5 — sharpen identity to exactly this child.
//
// The repaint gets the child broadly right; this pins the likeness.
//
// TWO BACKENDS, one contract. `SWAP_BACKEND` selects:
//
//   replicate (default) — the hosted ddvinh1/face-swap-gpu model.
//   local               — services/faceswap, the same inswapper model self-hosted.
//                         Errors if the service is down (strict; for testing).
//   auto                — try local first, fall back to hosted on ANY local
//                         failure. Fast when the box is healthy, slow-but-working
//                         when it isn't. The production-resilient setting.
//
// WHY LOCAL EXISTS: the hosted call bills ~$0.006 at Replicate's CPU rate of
// $0.0001/s, i.e. ~60 SECONDS of billed CPU, for a model whose real inference is
// under a second. The minute is cold start — it reloads several hundred MB of
// weights per call. Self-hosted with resident models the stage drops from
// ~55-90s to ~3.5s (measured), taking a page from ~90-170s to ~15-25s. That is what
// makes full-book rendering viable at all. See services/faceswap/README.md.
//
// Default stays `replicate` on purpose: the local service needs weights that are
// not in this repo, so anyone without it running is unaffected.
//
// LICENSING: both backends run InsightFace's inswapper, which is
// non-commercial/research licensed. Self-hosting does not change that. Most open
// face-swap tools (roop, facefusion, SimSwap) derive from the same model and
// inherit the restriction. This must be resolved before the product is sold.

// Pinned: the version-based /predictions endpoint requires it, and it stops
// behaviour drifting if the owner pushes an update.
//
// EXPERIMENT (feat/faceswap-gpu-model): swapped from codeplugtech/face-swap
// (278a81e7…, CPU, ~55-90s, ~$0.006) to ddvinh1/face-swap-gpu — an InsightFace
// inswapper variant that runs on a T4 GPU at ~1s and ~$0.0002/call. Same input
// contract (input_image = target artwork, swap_image = child photo), so this is a
// drop-in version bump. NOTE: it also exposes an `enhance` (GFPGAN) flag, left OFF
// so the pipeline's own restore stage still owns enhancement — keeping everything
// downstream identical.
const FACE_SWAP_VERSION = "d766886cf43ea2e9821703c392e3d403d2311eb8d013feef924655f9b7e2971d";

// Both backends' face detectors false-negative ("No face found") on some
// target/photo pairs far more than others. Two causes were found and fixed
// upstream of here — chibi-styled source art the detector can't parse (now
// countered by REPAINT_PROMPT's facial-proportions clause) and repaint output
// geometry resolving against the photo instead of the template (now pinned by
// the repaint stage's aspect_ratio). Retries remain as cheap insurance for
// ordinary flakiness. Do NOT read a high retry count as a reliability guarantee:
// a pairing that fails systematically has historically failed all 5 attempts.
const NO_FACE_RETRIES = 4;

/** The one user-facing message for a detection miss, whichever backend produced it. */
const NO_FACE_MESSAGE = "Couldn't find a usable face in the photo or the artwork.";

/** Thrown for a detection miss specifically, so the retry loop can tell it apart. */
class NoFaceError extends Error {}

/**
 * Resolves the photo to raw base64.
 *
 * The hosted model takes a URL or data URI and fetches it itself; the local
 * service takes bytes. In production `photoUri` is an R2 signed URL, so this
 * has to handle both forms.
 */
async function toBase64(photoUri: string): Promise<string> {
  if (photoUri.startsWith("data:")) return photoUri.slice(photoUri.indexOf(",") + 1);
  const buf = await fetchToBuffer(photoUri);
  return buf.toString("base64");
}

async function swapViaLocal(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const base = env.SWAP_LOCAL_URL.replace(/\/$/, "");

  let res: Response;
  try {
    res = await fetch(`${base}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_image: targetBuf.toString("base64"),
        swap_image: await toBase64(photoUri),
      }),
    });
  } catch (cause) {
    // A connection refusal here is almost always "the service isn't running",
    // which is worth saying plainly rather than surfacing a bare ECONNREFUSED.
    throw new ReplicateError(
      `Local swap service unreachable at ${base}. Is it running? ` +
        `(cd services/faceswap && python app.py). Set SWAP_BACKEND=replicate to use the hosted model instead. ` +
        `Cause: ${(cause as Error).message}`,
    );
  }

  if (res.status === 422) {
    throw new NoFaceError(NO_FACE_MESSAGE);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ReplicateError(`Local swap service failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as { image?: string };
  if (!json.image) throw new ReplicateError("Local swap service returned no image.");
  return Buffer.from(json.image, "base64");
}

async function swapViaReplicate(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  // runReplicate owns the hosted no-face retry loop, so this path passes the
  // budget straight through rather than double-retrying.
  const url = await runReplicate(
    "predictions",
    { version: FACE_SWAP_VERSION, input: { input_image: dataUri(targetBuf), swap_image: photoUri } },
    NO_FACE_RETRIES,
  );
  return fetchToBuffer(url);
}

/**
 * Local swap with its own retry loop. Retries here rather than inside the client
 * because a local retry is ~3.5s and free — the hosted one costs a paid
 * prediction and ~60s, which is why that budget is bounded and lives deeper in
 * the stack. Throws on exhaustion (a NoFaceError) or a hard failure (unreachable,
 * 5xx) — the caller decides whether that's fatal or a reason to fall back.
 */
async function swapViaLocalWithRetries(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await swapViaLocal(targetBuf, photoUri);
    } catch (err) {
      if (err instanceof NoFaceError && attempt < NO_FACE_RETRIES) {
        console.error(
          `[swap:local] detector reported no face (attempt ${attempt + 1}/${NO_FACE_RETRIES + 1}) — retrying`,
        );
        continue;
      }
      throw err;
    }
  }
}

/** Replace the repainted face with the child's actual face. */
export async function swapIdentity(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const backend = env.SWAP_BACKEND;
  if (backend === "replicate") return swapViaReplicate(targetBuf, photoUri);

  try {
    return await swapViaLocalWithRetries(targetBuf, photoUri);
  } catch (err) {
    // `auto`: a healthy local box is the fast path, but any local failure —
    // service down, 5xx, or no-face after local retries — falls back to the
    // hosted model rather than failing the render. Logged loudly so a silently
    // degraded box (every swap quietly paying full hosted price) is visible in
    // the logs instead of just looking slow.
    if (backend === "auto") {
      console.error(`[swap] local backend failed — falling back to hosted. Cause: ${(err as Error).message}`);
      return swapViaReplicate(targetBuf, photoUri);
    }
    // `local` (strict): surface a no-face as the friendly message, else the raw error.
    if (err instanceof NoFaceError) throw new ReplicateError(err.message);
    throw err;
  }
}
