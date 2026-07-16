import { Queue } from "bullmq";
import { createRedisConnection } from "./redis";

export const PIPELINE_QUEUE_NAME = "pipeline";

export interface PipelineJobData {
  sessionId: string;
}

let queueSingleton: Queue<PipelineJobData> | undefined;

export function getPipelineQueue(): Queue<PipelineJobData> {
  queueSingleton ??= new Queue<PipelineJobData>(PIPELINE_QUEUE_NAME, {
    connection: createRedisConnection(),
  });
  return queueSingleton;
}
