import type { PipelineStep } from "./pipeline/types";

// User-facing SSE copy, matching the proposal's exact wording.
export const STEP_MESSAGES: Record<PipelineStep, string> = {
  validate: "Checking your photo…",
  remove_bg: "Preparing your characters…",
  skin_tone: "Matching skin tone…",
  portrait: "Creating your illustrated characters…",
  composite: "Building your story pages…",
};
