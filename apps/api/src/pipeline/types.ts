export type PipelineStep = "validate" | "skin_tone" | "swap";

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

export interface CharacterInput {
  slot: string;
  photoUrl: string; // signed URL of the child's photo (the face source)
  skinToneHex?: string | null;
  hairToneHex?: string | null;
}
