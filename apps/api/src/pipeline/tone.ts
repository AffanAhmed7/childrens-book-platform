import sharp from "sharp";
import { getObjectBuffer } from "../storage";
import type { FaceBox } from "./types";

// Colour-matching passes that run AFTER the face swap.
//
// Why they exist: the swap only replaces the face. The character's neck, hands
// and arms keep the illustrator's skin tone, and their hair keeps the drawn
// colour. For a child whose tone/hair differs from the drawn character, that
// reads as a mismatch — a dark-skinned child ending up with light-skinned hands.
//
// Why this works on artwork but wouldn't on a photo: illustrated skin and hair
// are each painted in a narrow, consistent colour range, so we can find them by
// colour proximity alone — no segmentation model, no per-template mask, no cost.
//
// !! UNTESTED !! Both passes are off by default (see BOOKS in templates.ts).
// They must be validated against a real photo — especially a child whose tone
// differs sharply from the drawn character — before being switched on. The main
// risk is false positives: scene objects that happen to sit in the same colour
// range (wooden desks, sand, beige walls) would get recoloured too. `tolerance`
// controls that trade-off; `strength` lets the shift be partial.

export interface ToneOptions {
  // Max distance in RGB space for a pixel to count as skin/hair. Lower = safer
  // (fewer false positives), higher = catches more of the real region.
  tolerance?: number;
  // 0..1 — how far to push matched pixels toward the child's colour.
  strength?: number;
  // Restricts the recolour to a box around the character, so a false positive
  // somewhere else in the scene can't be damaged. Omit to apply page-wide.
  region?: FaceBox;
}

const DEFAULTS = { tolerance: 42, strength: 0.85 };

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Samples the dominant colour inside a box, ignoring transparent pixels and
 * (optionally) pixels far from a reference colour. Used to read the drawn
 * character's skin/hair colour straight off the artwork.
 */
export async function sampleRegionColour(
  image: Buffer,
  box: FaceBox,
  opts: { near?: { r: number; g: number; b: number }; tolerance?: number } = {},
): Promise<string> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const left = Math.max(0, Math.min(Math.round(box.left), Math.max(width - 1, 0)));
  const top = Math.max(0, Math.min(Math.round(box.top), Math.max(height - 1, 0)));
  const w = Math.max(1, Math.min(Math.round(box.width), width - left));
  const h = Math.max(1, Math.min(Math.round(box.height), height - top));

  const { data, info } = await sharp(image)
    .extract({ left, top, width: w, height: h })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const pr = data[i] ?? 0;
    const pg = data[i + 1] ?? 0;
    const pb = data[i + 2] ?? 0;
    const pa = info.channels === 4 ? (data[i + 3] ?? 255) : 255;
    if (pa < 200) continue;
    if (opts.near) {
      const d = Math.hypot(pr - opts.near.r, pg - opts.near.g, pb - opts.near.b);
      if (d > (opts.tolerance ?? 60)) continue;
    }
    r += pr;
    g += pg;
    b += pb;
    n += 1;
  }
  if (n === 0) {
    throw new Error("No opaque pixels found while sampling region colour.");
  }
  return rgbToHex(r / n, g / n, b / n);
}

/**
 * Shifts every pixel close to `fromHex` toward `toHex`, preserving each pixel's
 * own shading. Rather than flat-filling (which would destroy the illustrator's
 * highlights and shadows), it applies the from->to delta, so a shaded fold of
 * skin stays a shaded fold — just in the child's tone.
 */
export async function recolourRange(
  image: Buffer,
  fromHex: string,
  toHex: string,
  options: ToneOptions = {},
): Promise<Buffer> {
  const tolerance = options.tolerance ?? DEFAULTS.tolerance;
  const strength = options.strength ?? DEFAULTS.strength;
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);

  const delta = { r: to.r - from.r, g: to.g - from.g, b: to.b - from.b };
  // Nothing meaningful to do — skip the work and avoid touching the artwork.
  if (Math.hypot(delta.r, delta.g, delta.b) < 6) return image;

  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const region = options.region;
  const rx0 = region ? Math.max(0, Math.round(region.left)) : 0;
  const ry0 = region ? Math.max(0, Math.round(region.top)) : 0;
  const rx1 = region ? Math.min(width, Math.round(region.left + region.width)) : width;
  const ry1 = region ? Math.min(height, Math.round(region.top + region.height)) : height;

  for (let y = ry0; y < ry1; y += 1) {
    for (let x = rx0; x < rx1; x += 1) {
      const i = (y * width + x) * channels;
      const pr = data[i] ?? 0;
      const pg = data[i + 1] ?? 0;
      const pb = data[i + 2] ?? 0;
      const pa = channels === 4 ? (data[i + 3] ?? 255) : 255;
      if (pa < 8) continue;

      const dist = Math.hypot(pr - from.r, pg - from.g, pb - from.b);
      if (dist > tolerance) continue;

      // Feather by distance so the edge of the matched range blends out instead
      // of banding against neighbouring colours.
      const falloff = 1 - dist / tolerance;
      const k = strength * falloff;
      data[i] = Math.max(0, Math.min(255, pr + delta.r * k));
      data[i + 1] = Math.max(0, Math.min(255, pg + delta.g * k));
      data[i + 2] = Math.max(0, Math.min(255, pb + delta.b * k));
    }
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

// Where hair sits relative to a detected face: the band above the eyes, widened
// to catch the sides of the head. Approximate on purpose — it only needs to be
// good enough to *sample* the drawn hair colour, and the recolour itself is
// driven by colour matching, not by this box.
export function hairSampleBox(face: FaceBox): FaceBox {
  return {
    left: Math.round(face.left - face.width * 0.15),
    top: Math.round(face.top - face.height * 0.55),
    width: Math.round(face.width * 1.3),
    height: Math.round(face.height * 0.45),
  };
}

/**
 * Reads the child's own hair colour from their uploaded photo — the target
 * colour the drawn character's hair gets shifted to.
 */
export async function extractHairTone(rawKey: string, faceBox: FaceBox): Promise<string> {
  const buffer = await getObjectBuffer(rawKey);
  return sampleRegionColour(buffer, hairSampleBox(faceBox));
}

// A generous box around the character, used to keep recolouring away from the
// rest of the scene. Wide enough to include hands/arms near the body.
export function characterRegion(face: FaceBox, imageWidth: number, imageHeight: number): FaceBox {
  const left = Math.max(0, Math.round(face.left - face.width * 2.2));
  const top = Math.max(0, Math.round(face.top - face.height * 1.4));
  const right = Math.min(imageWidth, Math.round(face.left + face.width * 3.2));
  const bottom = Math.min(imageHeight, Math.round(face.top + face.height * 5.5));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
