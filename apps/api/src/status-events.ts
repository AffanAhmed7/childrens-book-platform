import type { Redis } from "ioredis";
import { createRedisConnection } from "./redis";
import type { PipelineStep } from "./pipeline/types";

export type StatusEvent =
  | { type: "status"; step: PipelineStep; slot?: string; message: string }
  | { type: "done"; previewUrl: string }
  | { type: "error"; step: PipelineStep; slot?: string; message: string };

function channelFor(sessionId: string): string {
  return `session:${sessionId}`;
}

let publisher: Redis | undefined;
function getPublisher(): Redis {
  publisher ??= createRedisConnection();
  return publisher;
}

export async function publishStatus(sessionId: string, event: StatusEvent): Promise<void> {
  await getPublisher().publish(channelFor(sessionId), JSON.stringify(event));
}

// Returns an unsubscribe function. Each call opens its own Redis connection —
// required by ioredis, since a client in subscriber mode can't run other commands.
export function subscribeStatus(
  sessionId: string,
  onEvent: (event: StatusEvent) => void,
): () => Promise<void> {
  const subscriber = createRedisConnection();
  void subscriber.subscribe(channelFor(sessionId));
  subscriber.on("message", (_channel, message) => {
    onEvent(JSON.parse(message) as StatusEvent);
  });

  return async () => {
    await subscriber.unsubscribe(channelFor(sessionId));
    subscriber.disconnect();
  };
}
