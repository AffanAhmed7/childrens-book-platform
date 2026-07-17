import type { PipelineStep } from "./pipeline/types";

// User-facing SSE copy.
export const STEP_MESSAGES: Record<PipelineStep, string> = {
  validate: "Checking your photo…",
  skin_tone: "Matching skin tone…",
  swap: "Building your story pages…",
};
