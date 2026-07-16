// Multi-character end-to-end check: create a session with 2 characters, upload
// a different real photo for each, watch the SSE stream through both
// characters' steps plus the final composite step.
//
// Usage: node test/e2e-multichar.mjs <photo1.jpg> <slot1> <name1> <photo2.jpg> <slot2> <name2>

import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3001";
const longPollAgent = new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 });

const [photo1, slot1, name1, photo2, slot2, name2] = process.argv.slice(2);
if (!photo1 || !slot1 || !name1 || !photo2 || !slot2 || !name2) {
  console.error("Usage: node test/e2e-multichar.mjs <photo1> <slot1> <name1> <photo2> <slot2> <name2>");
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
        return data;
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}

async function uploadCharacterPhoto(sessionId, characterId, photoPath) {
  const uploadUrlResponse = await fetch(
    `${baseUrl}/api/sessions/${sessionId}/characters/${characterId}/upload-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "image/jpeg" }),
    },
  );
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
  console.log(`Uploaded ${photoPath} -> ${objectKey}`);

  return fetch(`${baseUrl}/api/sessions/${sessionId}/characters/${characterId}/upload-confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectKey }),
  }).then((r) => r.json());
}

async function main() {
  const createResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storyId: "two-children-park",
      characters: [
        { slot: slot1, childName: name1 },
        { slot: slot2, childName: name2 },
      ],
    }),
  });
  const { sessionId, characters } = await createResponse.json();
  console.log(`Session created: ${sessionId}`);
  console.log("Characters:", characters);

  const char1 = characters.find((c) => c.slot === slot1);
  const char2 = characters.find((c) => c.slot === slot2);

  const statusPromise = listenToStatus(sessionId);

  const confirm1 = await uploadCharacterPhoto(sessionId, char1.characterId, photo1);
  console.log("Confirm 1:", confirm1);
  const confirm2 = await uploadCharacterPhoto(sessionId, char2.characterId, photo2);
  console.log("Confirm 2:", confirm2);

  const finalEvent = await statusPromise;
  console.log("Final event:", finalEvent);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
