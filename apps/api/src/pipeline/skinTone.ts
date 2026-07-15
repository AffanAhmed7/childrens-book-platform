import sharp from "sharp";
import { getObjectBuffer } from "../storage";
import type { FaceBox } from "./types";

export async function extractSkinTone(noBgKey: string, faceBox: FaceBox): Promise<string> {
  const buffer = await getObjectBuffer(noBgKey);
  const image = sharp(buffer).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  // Face detection ran against the raw photo; the no-bg image shares the same
  // dimensions (remove.bg preserves them), so the box is reused directly here,
  // clamped defensively in case of any edge-case mismatch.
  const left = Math.min(Math.max(faceBox.left, 0), Math.max(width - 1, 0));
  const top = Math.min(Math.max(faceBox.top, 0), Math.max(height - 1, 0));
  const cropWidth = Math.max(1, Math.min(faceBox.width, width - left));
  const cropHeight = Math.max(1, Math.min(faceBox.height, height - top));

  const { data, info } = await image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += channels) {
    const red = data[i] ?? 0;
    const green = data[i + 1] ?? 0;
    const blue = data[i + 2] ?? 0;
    const alpha = channels === 4 ? (data[i + 3] ?? 255) : 255;
    if (alpha < 200) continue; // skip transparent/background pixels
    r += red;
    g += green;
    b += blue;
    count += 1;
  }

  if (count === 0) {
    throw new Error("No opaque pixels found in the face region to sample skin tone from.");
  }

  const avg = (value: number) => Math.round(value / count);
  const toHex = (value: number) => value.toString(16).padStart(2, "0");

  return `#${toHex(avg(r))}${toHex(avg(g))}${toHex(avg(b))}`;
}
