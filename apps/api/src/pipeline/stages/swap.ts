import { runReplicate, fetchToBuffer } from "../replicate";
import { dataUri } from "../dataUri";

// STAGE 2 of 5 — sharpen identity to exactly this child.
//
// The repaint gets the child broadly right; this pins the likeness. Cheap
// (~$0.006) and fast relative to the repaint.
//
// LICENSING: this is InsightFace's inswapper, which is non-commercial/research
// licensed. InsightFace sell a separate commercial licence. Most open face-swap
// tools (roop, facefusion, SimSwap) derive from the same model and inherit the
// restriction. This must be resolved before the product is sold.

// Pinned: the version-based /predictions endpoint requires it, and it stops
// behaviour drifting if the owner pushes an update.
const FACE_SWAP_VERSION = "278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34";

// This model's own face detector false-negatives ("No face found") on some
// target/photo pairs far more than others. Two causes were found and fixed
// upstream of here — chibi-styled source art the detector can't parse (now
// countered by REPAINT_PROMPT's facial-proportions clause) and repaint output
// geometry resolving against the photo instead of the template (now pinned by
// the repaint stage's aspect_ratio). Retries remain as cheap insurance for
// ordinary flakiness. Do NOT read a high retry count as a reliability guarantee:
// a pairing that fails systematically has historically failed all 5 attempts.
const NO_FACE_RETRIES = 4;

/** Replace the repainted face with the child's actual face. */
export async function swapIdentity(targetBuf: Buffer, photoUri: string): Promise<Buffer> {
  const url = await runReplicate(
    "predictions",
    { version: FACE_SWAP_VERSION, input: { input_image: dataUri(targetBuf), swap_image: photoUri } },
    NO_FACE_RETRIES,
  );
  return fetchToBuffer(url);
}
