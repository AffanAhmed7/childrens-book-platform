import type { PipelineStep } from "./pipeline/types";

// User-facing SSE copy.
export const STEP_MESSAGES: Record<PipelineStep, string> = {
  validate: "Checking your photo…",
  render: "Building your story pages…",
};
