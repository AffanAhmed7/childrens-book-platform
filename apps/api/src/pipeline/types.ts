export type PipelineStep = "validate" | "remove_bg" | "skin_tone" | "portrait" | "composite";

export interface FaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ValidationResult {
  width: number;
  height: number;
  faceBox: FaceBox;
}
