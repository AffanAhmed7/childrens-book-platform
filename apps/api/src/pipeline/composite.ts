import sharp from "sharp";
import path from "node:path";
import { getObjectBuffer } from "../storage";
import { detectFaces } from "./faceDetect";
import type { FaceBox } from "./types";

export class CompositeError extends Error {}

// Placeholder template (see PROJECT_PLAN.md decision log): generated via the
// free black-forest-labs/FLUX.1-schnell Space since no real artwork exists
// yet from the client. Swappable for real art later — only TEMPLATE_PATH and
// TEMPLATE_SLOTS need to change, nothing else in the pipeline.
const TEMPLATE_PATH = path.resolve(process.cwd(), "../../assets/templates/two-children-park.png");

// Auto-detected once via blazeface against the template image (both faces
// only detected reliably when the image was cropped in half first — see
// PROJECT_PLAN.md). Hardcoded since the template is a static, checked-in
// asset, not something re-detected at request time.
const TEMPLATE_SLOTS: Record<string, FaceBox> = {
  child_1: { left: 299, top: 362, width: 119, height: 162 },
  child_2: { left: 780, top: 391, width: 180, height: 123 },
};

// Relaxed vs validate.ts's 0.9 — stylized/illustrated portraits score lower
// with a detector trained mostly on real photos.
const FACE_CONFIDENCE_THRESHOLD = 0.7;

export interface CharacterComposite {
  slot: string;
  noBgKey: string;
}

// A soft radial fade (opaque center, transparent edges) applied to each face
// crop via "dest-in" blending before pasting — softens the hard rectangular
// seam a plain crop-and-paste leaves where it meets the template artwork.
async function createFeatheredMask(width: number, height: number): Promise<Buffer> {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="fade" cx="50%" cy="45%" r="65%">
        <stop offset="55%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#fade)" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function compositeSession(characters: CharacterComposite[]): Promise<Buffer> {
  const overlays: sharp.OverlayOptions[] = [];

  for (const character of characters) {
    const slotBox = TEMPLATE_SLOTS[character.slot];
    if (!slotBox) {
      throw new CompositeError(`No template slot defined for "${character.slot}".`);
    }

    const portraitBuffer = await getObjectBuffer(character.noBgKey);
    const { width, height, faces } = await detectFaces(portraitBuffer);
    const face = faces
      .filter((f) => f.score >= FACE_CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)[0];
    if (!face) {
      throw new CompositeError(
        `Could not find a face in the generated portrait for slot "${character.slot}".`,
      );
    }

    // Pad around the detected face so hair/chin aren't cut off, clamped to
    // the portrait's actual bounds.
    const pad = Math.round(Math.max(face.box.width, face.box.height) * 0.4);
    const cropLeft = Math.max(0, face.box.left - pad);
    const cropTop = Math.max(0, face.box.top - pad);
    const cropRight = Math.min(width, face.box.left + face.box.width + pad);
    const cropBottom = Math.min(height, face.box.top + face.box.height + pad);

    const faceCrop = await sharp(portraitBuffer)
      .extract({
        left: cropLeft,
        top: cropTop,
        width: cropRight - cropLeft,
        height: cropBottom - cropTop,
      })
      .resize(slotBox.width, slotBox.height, { fit: "cover" })
      .ensureAlpha()
      .toBuffer();

    const mask = await createFeatheredMask(slotBox.width, slotBox.height);
    const featheredFace = await sharp(faceCrop)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();

    overlays.push({ input: featheredFace, left: slotBox.left, top: slotBox.top });
  }

  return sharp(TEMPLATE_PATH).ensureAlpha().composite(overlays).png().toBuffer();
}
