import sharp from "sharp";
import * as tf from "@tensorflow/tfjs";
import * as blazeface from "@tensorflow-models/blazeface";
import { getObjectBuffer } from "../storage";
import type { ValidationResult } from "./types";

// Uses @tensorflow/tfjs (pure JS/WASM, CPU backend) + blazeface instead of the
// originally-proposed face-api.js, which requires the native `canvas` package —
// a risky native-build dependency on Windows under a tight deadline. blazeface
// gives bounding boxes (no landmarks), which is all "exactly one usable face"
// validation needs; skin-tone sampling uses the same box (see skinTone.ts).
const MIN_DIMENSION = 200;
const FACE_CONFIDENCE_THRESHOLD = 0.9;

export class ValidationError extends Error {}

let modelPromise: Promise<blazeface.BlazeFaceModel> | undefined;

async function getModel(): Promise<blazeface.BlazeFaceModel> {
  modelPromise ??= (async () => {
    await tf.setBackend("cpu");
    await tf.ready();
    return blazeface.load();
  })();
  return modelPromise;
}

export async function validatePhoto(rawKey: string): Promise<ValidationResult> {
  const buffer = await getObjectBuffer(rawKey);
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width < MIN_DIMENSION || info.height < MIN_DIMENSION) {
    throw new ValidationError(
      `Photo is too small (${info.width}x${info.height}px) — please upload at least ${MIN_DIMENSION}x${MIN_DIMENSION}px.`,
    );
  }

  const model = await getModel();
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);

  try {
    const predictions = await model.estimateFaces(tensor, false);
    const confidentFaces = predictions.filter((prediction) => {
      const score = Array.isArray(prediction.probability)
        ? prediction.probability[0]
        : (prediction.probability as unknown as number);
      return (score ?? 0) >= FACE_CONFIDENCE_THRESHOLD;
    });

    if (confidentFaces.length === 0) {
      throw new ValidationError("No face detected — please upload a clear photo of the child's face.");
    }
    if (confidentFaces.length > 1) {
      throw new ValidationError("Multiple faces detected — please upload a photo with just one child.");
    }

    const face = confidentFaces[0];
    if (!face) {
      throw new ValidationError("No face detected — please upload a clear photo of the child's face.");
    }
    const [topLeftX, topLeftY] = face.topLeft as number[];
    const [bottomRightX, bottomRightY] = face.bottomRight as number[];
    if (topLeftX === undefined || topLeftY === undefined || bottomRightX === undefined || bottomRightY === undefined) {
      throw new ValidationError("Could not determine face position in the photo.");
    }

    return {
      width: info.width,
      height: info.height,
      faceBox: {
        left: Math.max(0, Math.round(topLeftX)),
        top: Math.max(0, Math.round(topLeftY)),
        width: Math.max(1, Math.round(bottomRightX - topLeftX)),
        height: Math.max(1, Math.round(bottomRightY - topLeftY)),
      },
    };
  } finally {
    tensor.dispose();
  }
}
