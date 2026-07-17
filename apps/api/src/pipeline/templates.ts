import path from "node:path";

// Book/page configuration.
//
// This used to carry per-template calibration (eye anchors, head scale, neck
// fades, hair-cover ellipses) because we generated a head and pasted it in.
// The face-swap engine (faceSwap.ts) needs none of that: it finds the character
// in the artwork itself. So a page is now just an image, and adding a page to a
// book is one line here — no code, no tuning, no calibration.

export interface BookPage {
  id: string; // stable slug; also the R2 filename for the finished page
  imagePath: string; // the illustrator's finished page artwork
  caption?: string;
  // Shown in the free preview. Everything else is only generated once the book
  // is bought — see PipelineMode. This is the main cost lever: most visitors
  // never buy, so we don't pay to render their whole book.
  preview?: boolean;
  // Which character slot each DRAWN character maps to, in left-to-right order
  // of the faces on the page. Omit when the drawn order already matches the
  // session's character order (the common case).
  slots?: string[];
}

export interface HairVariant {
  // The illustrator supplies a few hair shapes per character (short / long /
  // curly); we pick the closest to the child and colour-match it. This is how
  // the child's hair actually gets represented — the swap itself only replaces
  // the face. Art-side work; not wired up yet.
  id: string;
  imagePath: string;
}

export interface ToneSettings {
  // !! Both default OFF — the passes are implemented but UNTESTED. !!
  // See tone.ts. They must be validated against a child whose skin/hair differs
  // sharply from the drawn character before being enabled, because the risk is
  // recolouring scene objects that share the same colour range.
  skin: boolean;
  hair: boolean;
  skinTolerance?: number;
  skinStrength?: number;
  hairTolerance?: number;
  hairStrength?: number;
}

export interface BookConfig {
  title: string;
  pages: BookPage[];
  hairVariants?: HairVariant[];
  tone?: ToneSettings;
}

export const DEFAULT_TONE: ToneSettings = { skin: false, hair: false };

const ASSETS = path.resolve(process.cwd(), "../../assets/templates");

// Multi-character books need no extra machinery: personalize.ts detects every
// drawn character on a page and swaps each mapped child onto their own. Faces
// are matched left-to-right against the session's character slots, so a page
// drawn with two children just works once the session has child_1 and child_2.
// Use `slots` only when a page's drawn order isn't left-to-right, or when a page
// features a subset of the cast:
//
//   pages: [
//     // leftmost drawn child = child_1, next = child_2
//     { id: "park", imagePath: path.join(ASSETS, "park.jpeg") },
//     // page draws child_2 on the left and child_1 on the right
//     { id: "beach", imagePath: path.join(ASSETS, "beach.jpeg"), slots: ["child_2", "child_1"] },
//     // page only features child_2; any other drawn face is left as the artist drew it
//     { id: "solo", imagePath: path.join(ASSETS, "solo.jpeg"), slots: ["child_2"] },
//   ]
export const BOOKS: Record<string, BookConfig> = {
  "demo-book": {
    title: "Demo book — mixed scenes",
    tone: DEFAULT_TONE,
    pages: [
      {
        id: "workshop",
        imagePath: path.join(ASSETS, "WhatsApp Image 2026-07-16 at 8.50.37 AM (2).jpeg"),
        caption: "The young inventor",
        preview: true,
      },
      { id: "astronaut", imagePath: path.join(ASSETS, "temp_1.jpeg"), caption: "Floating among the planets" },
      { id: "pilot", imagePath: path.join(ASSETS, "temp_2.jpeg"), caption: "Taking to the skies" },
      { id: "architect", imagePath: path.join(ASSETS, "temp_3.jpeg"), caption: "Building the city" },
    ],
  },
};

// Finished pages live at a predictable key, so both the worker (writing) and the
// routes (listing) derive it from the book config alone — no extra bookkeeping
// in the database.
export function pageObjectKey(sessionId: string, pageId: string): string {
  return `sessions/${sessionId}/pages/${pageId}.png`;
}

export function getBook(storyId: string): BookConfig {
  const book = BOOKS[storyId];
  if (!book) {
    throw new Error(`No book configured for storyId "${storyId}".`);
  }
  return book;
}

export function getTone(book: BookConfig): ToneSettings {
  return book.tone ?? DEFAULT_TONE;
}

// Preview mode renders only the flagged pages; if a book flags none, the first
// page stands in so a preview is never empty.
export function pagesFor(book: BookConfig, mode: "preview" | "full"): BookPage[] {
  if (mode === "full") return book.pages;
  const flagged = book.pages.filter((p) => p.preview);
  if (flagged.length > 0) return flagged;
  return book.pages.slice(0, 1);
}
