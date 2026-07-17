import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { detectFaces } from "./faceDetect";
import { swapFace } from "./faceSwap";
import { recolourRange, sampleRegionColour, hairSampleBox, characterRegion } from "./tone";
import type { BookPage, ToneSettings } from "./templates";
import type { FaceBox } from "./types";

export class PersonalizeError extends Error {}

// Illustrated faces score lower than photos with a detector trained on real
// faces, so this is well below validate.ts's 0.9.
const FACE_CONFIDENCE_THRESHOLD = 0.6;

export interface CharacterInput {
  slot: string;
  photoUrl: string; // signed URL of the child's photo (the face source)
  skinToneHex?: string | null;
  hairToneHex?: string | null;
}

/**
 * Finds the drawn characters on a page, left to right.
 *
 * Ordering by x is the whole mapping convention for multi-character pages: the
 * leftmost drawn character is the page's first slot. A page can override this
 * with an explicit `slots` list when the drawn order isn't left-to-right.
 */
async function detectPageCharacters(pageBuffer: Buffer): Promise<FaceBox[]> {
  const { faces } = await detectFaces(pageBuffer);
  return faces
    .filter((f) => f.score >= FACE_CONFIDENCE_THRESHOLD)
    .sort((a, b) => a.box.left - b.box.left)
    .map((f) => f.box);
}

// The swap model has no face-index input — it swaps whatever face it finds. So
// each character is handed a crop containing only them. The crop is padded well
// beyond the face so the model's own detector has context to work with.
function cropBox(face: FaceBox, width: number, height: number): FaceBox {
  const padX = face.width * 1.1;
  const padY = face.height * 1.1;
  const left = Math.max(0, Math.round(face.left - padX));
  const top = Math.max(0, Math.round(face.top - padY));
  const right = Math.min(width, Math.round(face.left + face.width + padX));
  const bottom = Math.min(height, Math.round(face.top + face.height + padY));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * Pastes a swapped crop back over the page through a feathered ellipse around
 * the face.
 *
 * Only the face changed, so an ellipse is enough — and it avoids the visible
 * rectangle that pasting the whole crop would leave when the model re-encodes
 * the untouched pixels slightly differently.
 */
async function faceOverlay(swappedCrop: Buffer, crop: FaceBox, face: FaceBox): Promise<sharp.OverlayOptions> {
  // Resize defensively: the model is not contractually bound to return the same
  // dimensions it was given.
  const normalized = await sharp(swappedCrop).resize(crop.width, crop.height, { fit: "fill" }).ensureAlpha().toBuffer();

  const cx = face.left + face.width / 2 - crop.left;
  const cy = face.top + face.height / 2 - crop.top;
  const rx = face.width * 0.72;
  const ry = face.height * 0.82;
  const mask = await sharp(
    Buffer.from(
      `<svg width="${crop.width}" height="${crop.height}" xmlns="http://www.w3.org/2000/svg"><defs>
        <radialGradient id="m" cx="${(cx / crop.width) * 100}%" cy="${(cy / crop.height) * 100}%" r="50%">
          <stop offset="72%" stop-color="white" stop-opacity="1"/>
          <stop offset="100%" stop-color="white" stop-opacity="0"/>
        </radialGradient></defs>
        <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#m)"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

  const feathered = await sharp(normalized).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  return { input: feathered, left: crop.left, top: crop.top };
}

/**
 * Applies the (untested, opt-in) skin and hair colour passes for one character.
 * See tone.ts for why these exist and what the risks are.
 */
async function applyToneMatching(
  original: Buffer,
  page: Buffer,
  face: FaceBox,
  character: CharacterInput,
  tone: ToneSettings,
): Promise<Buffer> {
  const meta = await sharp(page).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const region = characterRegion(face, width, height);
  let out = page;

  if (tone.skin && character.skinToneHex) {
    // Read the drawn character's skin from the ORIGINAL artwork, pre-swap. Post
    // -swap, this box is the child's own face — sampling it there would read the
    // target colour back as the source, produce a near-zero delta, and leave
    // the untouched arms/hands in the illustrator's original tone.
    const cheekBox: FaceBox = {
      left: Math.round(face.left + face.width * 0.15),
      top: Math.round(face.top + face.height * 0.55),
      width: Math.max(1, Math.round(face.width * 0.7)),
      height: Math.max(1, Math.round(face.height * 0.3)),
    };
    const drawnSkin = await sampleRegionColour(original, cheekBox);
    out = await recolourRange(out, drawnSkin, character.skinToneHex, {
      tolerance: tone.skinTolerance,
      strength: tone.skinStrength,
      region,
    });
  }

  if (tone.hair && character.hairToneHex) {
    // The swap doesn't touch hair, so sampling pre- or post-swap is equivalent
    // here — pre-swap is used for consistency with the skin pass above.
    const drawnHair = await sampleRegionColour(original, hairSampleBox(face));
    out = await recolourRange(out, drawnHair, character.hairToneHex, {
      tolerance: tone.hairTolerance,
      strength: tone.hairStrength,
      region,
    });
  }

  return out;
}

/**
 * Personalizes one book page: swaps each child onto their drawn character and
 * (optionally) matches skin/hair colour.
 *
 * Characters on a page are independent, non-overlapping regions, so their swaps
 * are issued in parallel and composited together at the end.
 */
export async function personalizePage(
  page: BookPage,
  characters: CharacterInput[],
  tone: ToneSettings,
): Promise<Buffer> {
  const original = await readFile(page.imagePath);
  const meta = await sharp(original).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const drawnFaces = await detectPageCharacters(original);
  if (drawnFaces.length === 0) {
    throw new PersonalizeError(`No character face detected on page "${page.id}".`);
  }

  // Map each drawn character to the child who should become them.
  const slotOrder = page.slots ?? characters.map((c) => c.slot);
  const assignments: { face: FaceBox; character: CharacterInput }[] = [];
  for (let i = 0; i < drawnFaces.length; i += 1) {
    const slot = slotOrder[i];
    const character = slot ? characters.find((c) => c.slot === slot) : undefined;
    const face = drawnFaces[i];
    // A page may legitimately draw more characters than this session has
    // children (background kids, a sibling in a solo book) — leave those as
    // the illustrator drew them rather than reusing a face.
    if (character && face) assignments.push({ face, character });
  }
  if (assignments.length === 0) {
    throw new PersonalizeError(`No character on page "${page.id}" maps to an uploaded child.`);
  }

  const overlays = await Promise.all(
    assignments.map(async ({ face, character }) => {
      const crop = cropBox(face, width, height);
      const cropBuffer = await sharp(original).extract(crop).png().toBuffer();
      const swapped = await swapFace(cropBuffer, character.photoUrl);
      return faceOverlay(swapped, crop, face);
    }),
  );

  let result = await sharp(original).ensureAlpha().composite(overlays).png().toBuffer();

  if (tone.skin || tone.hair) {
    for (const { face, character } of assignments) {
      result = await applyToneMatching(original, result, face, character, tone);
    }
  }

  return result;
}
