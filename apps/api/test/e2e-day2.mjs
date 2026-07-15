// Day 2 end-to-end check: create a session, upload a real photo, then watch the
// live SSE status stream through validate -> remove_bg -> skin_tone -> portrait.
//
// Usage: node test/e2e-day2.mjs ./path/to/photo.jpg
// Requires the API server running (npm run dev) with REDIS_URL, R2 and
// remove.bg configured in apps/api/.env. Portrait generation runs on a free
// Hugging Face Space with variable latency (seconds to several minutes) — this
// script uses a long-timeout dispatcher so it doesn't give up early.

import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";
const photoPath = process.argv[2];
const longPollAgent = new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 });

if (!photoPath) {
  console.error("Usage: node test/e2e-day2.mjs <path-to-photo.jpg>");
  process.exit(1);
}

async function listenToStatus(sessionId) {
  const response = await undiciFetch(`${baseUrl}/api/sessions/${sessionId}/status`, {
    headers: { Accept: "text/event-stream" },
    dispatcher: longPollAgent,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open status stream: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const eventLine = frame.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      const event = eventLine?.slice("event:".length).trim();
      const data = dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : undefined;
      console.log(`[${event}]`, data);
      if (event === "done" || event === "error") {
        return;
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}

async function main() {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storyId: "story-1", childName: "Test Child" }),
  });
  const { sessionId } = await createResponse.json();
  console.log(`Session created: ${sessionId}`);

  const uploadUrlResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType: "image/jpeg" }),
  });
  const { uploadUrl, objectKey } = await uploadUrlResponse.json();

  const fileBuffer = await readFile(photoPath);
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: fileBuffer,
  });
  if (!putResponse.ok) {
    throw new Error(`Upload to R2 failed: ${putResponse.status}`);
  }
  console.log(`Uploaded photo -> ${objectKey}`);

  // Start listening before confirming, so we don't miss the first status event.
  const statusPromise = listenToStatus(sessionId);

  await fetch(`${baseUrl}/api/sessions/${sessionId}/upload-confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectKey }),
  });
  console.log("Upload confirmed — pipeline job enqueued.");

  await statusPromise;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
