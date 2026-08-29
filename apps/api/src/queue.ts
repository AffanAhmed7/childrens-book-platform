import { Queue, QueueEvents } from "bullmq";
import { createQueueRedisConnection, createRedisConnection } from "./redis";

export const PIPELINE_QUEUE_NAME = "pipeline";

// "preview" renders only the pages flagged for the free preview; "full" renders
// the whole book (run after purchase). Splitting these is the main cost control:
// most visitors preview and never buy.
export type PipelineMode = "preview" | "full";

export interface PipelineJobData {
  sessionId: string;
  mode: PipelineMode;
}

let queueSingleton: Queue<PipelineJobData> | undefined;

export function getPipelineQueue(): Queue<PipelineJobData> {
  queueSingleton ??= new Queue<PipelineJobData>(PIPELINE_QUEUE_NAME, {
    connection: createQueueRedisConnection(),
  });
  return queueSingleton;
}

let queueEventsSingleton: QueueEvents | undefined;

export function getPipelineQueueEvents(): QueueEvents {
  queueEventsSingleton ??= new QueueEvents(PIPELINE_QUEUE_NAME, {
    connection: createRedisConnection(),
  });
  return queueEventsSingleton;
}
