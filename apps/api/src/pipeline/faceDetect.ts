import sharp from "sharp";
import * as tf from "@tensorflow/tfjs";
import * as blazeface from "@tensorflow-models/blazeface";
import type { FaceBox } from "./types";

// Shared by validate.ts (exactly-one-face check on a raw photo) and
// composite.ts (locating the face within a generated portrait to crop it).
// Uses @tensorflow/tfjs (pure JS/WASM, CPU backend) + blazeface instead of
// face-api.js, which requires the native `canvas` package — a risky native
// build dependency on Windows under a tight deadline.

let modelPromise: Promise<blazeface.BlazeFaceModel> | undefined;

async function getModel(): Promise<blazeface.BlazeFaceModel> {
  modelPromise ??= (async () => {
    await tf.setBackend("cpu");
    await tf.ready();
    return blazeface.load();
  })();
  return modelPromise;
}

export interface Point {
  x: number;
  y: number;
}

// blazeface's fixed landmark order: right eye, left eye, nose tip, mouth, right
// ear, left ear — "right"/"left" are the subject's own left/right, i.e. mirrored
// in image space (subject's right eye appears on the left side of the frame).
export interface FaceLandmarks {
  rightEye: Point;
  leftEye: Point;
  noseTip: Point;
  mouth: Point;
  rightEar: Point;
  leftEar: Point;
}

export interface DetectedFace {
  score: number;
  box: FaceBox;
  landmarks: FaceLandmarks | undefined;
}

export interface DetectFacesResult {
  width: number;
  height: number;
  faces: DetectedFace[];
}

export async function detectFaces(imageBuffer: Buffer): Promise<DetectFacesResult> {
  const { data, info } = await sharp(imageBuffer)
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const model = await getModel();
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);

  try {
    const predictions = await model.estimateFaces(tensor, false);
    const faces: DetectedFace[] = [];

    for (const prediction of predictions) {
      const topLeft = prediction.topLeft as number[];
      const bottomRight = prediction.bottomRight as number[];
      const [tlx, tly] = topLeft;
      const [brx, bry] = bottomRight;
      if (tlx === undefined || tly === undefined || brx === undefined || bry === undefined) {
        continue;
      }
      const rawScore = Array.isArray(prediction.probability)
        ? prediction.probability[0]
        : (prediction.probability as unknown as number);

      const rawLandmarks = prediction.landmarks as number[][] | undefined;
      let landmarks: FaceLandmarks | undefined;
      if (Array.isArray(rawLandmarks) && rawLandmarks.length >= 6) {
        const toPoint = (pair: number[] | undefined): Point => ({ x: pair?.[0] ?? 0, y: pair?.[1] ?? 0 });
        landmarks = {
          rightEye: toPoint(rawLandmarks[0]),
          leftEye: toPoint(rawLandmarks[1]),
          noseTip: toPoint(rawLandmarks[2]),
          mouth: toPoint(rawLandmarks[3]),
          rightEar: toPoint(rawLandmarks[4]),
          leftEar: toPoint(rawLandmarks[5]),
        };
      }

      faces.push({
        score: rawScore ?? 0,
        box: {
          left: Math.max(0, Math.round(tlx)),
          top: Math.max(0, Math.round(tly)),
          width: Math.max(1, Math.round(brx - tlx)),
          height: Math.max(1, Math.round(bry - tly)),
        },
        landmarks,
      });
    }

    return { width: info.width, height: info.height, faces };
  } finally {
    tensor.dispose();
  }
}
