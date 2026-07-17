import sharp from "sharp";
import { getObjectBuffer } from "../storage";
import type { FaceBox } from "./types";

// A cheek/chin band well inside the detected face box — narrower than the full
// box so it excludes hair, eyebrows, eyes and mouth, which pull the average
// toward grey. (The full-box average was measured to return grey on a real
// photo — clearly wrong for a tone estimate.)
function cheekBand(box: FaceBox): FaceBox {
  return {
    left: box.left + box.width * 0.22,
    top: box.top + box.height * 0.55,
    width: box.width * 0.56,
    height: box.height * 0.28,
  };
}

export async function extractSkinTone(rawKey: string, faceBox: FaceBox): Promise<string> {
  const buffer = await getObjectBuffer(rawKey);
  const image = sharp(buffer).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const box = cheekBand(faceBox);
  const left = Math.min(Math.max(Math.round(box.left), 0), Math.max(width - 1, 0));
  const top = Math.min(Math.max(Math.round(box.top), 0), Math.max(height - 1, 0));
  const cropWidth = Math.max(1, Math.min(Math.round(box.width), width - left));
  const cropHeight = Math.max(1, Math.min(Math.round(box.height), height - top));

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
    if (alpha < 200) continue; // skip transparent pixels, when the source has any
    r += red;
    g += green;
    b += blue;
    count += 1;
  }

  if (count === 0) {
    throw new Error("No opaque pixels found in the cheek region to sample skin tone from.");
  }

  const avg = (value: number) => Math.round(value / count);
  const toHex = (value: number) => value.toString(16).padStart(2, "0");

  return `#${toHex(avg(r))}${toHex(avg(g))}${toHex(avg(b))}`;
}
