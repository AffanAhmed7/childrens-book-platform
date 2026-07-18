import { createDownloadUrl } from "../storage";

// Replicate fetches the child's photo itself, so it gets a signed link rather
// than the bytes. Long-lived enough to cover a whole book's pages.
export function childPhotoUrl(rawKey: string): Promise<string> {
  return createDownloadUrl(rawKey, 3600);
}
