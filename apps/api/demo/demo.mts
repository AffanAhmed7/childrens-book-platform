// Live demo runner (built for a silent screen-recording — the output narrates
// itself). Each step names the source file that implements it (ctrl+click in the
// VS Code terminal to jump to it) and opens that step's image, so the recording
// shows the actual transformation.
//
// The final swap runs LIVE against the real src/pipeline/faceSwap.ts.
//
// Usage (from apps/api):
//   npx tsx demo/demo.mts          walk the steps (prints file links)
//   npx tsx demo/demo.mts --open   also open each step's image as it runs

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
import { personalizePage } from "../src/pipeline/personalize.js";
import { getBook, getTone } from "../src/pipeline/templates.js";

const STORY_ID = "demo-book";
const PAGE_ID = "workshop"; // one page keeps the demo fast and cheap (~$0.007)
const OPEN = process.argv.includes("--open");

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const asset = (f: string) => path.join(HERE, "assets", f);
const outFile = path.join(HERE, "output", "finished-page.png");

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  teal: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function open(absPath: string) {
  if (OPEN) spawn("cmd", ["/c", "start", "", absPath], { stdio: "ignore", detached: true }).unref();
}

interface Stage {
  title: string;
  file: string;
  image: string;
  work?: () => Promise<void>;
}

async function runStage(n: number, s: Stage) {
  if (s.work) {
    process.stdout.write(
      `\n  ${c.teal(`STEP ${n}`)}  ${c.bold(s.title)}\n          ${c.dim("code:")}  ${s.file}\n          ${c.dim("working…")}\n`,
    );
    await s.work();
  } else {
    process.stdout.write(`\n  ${c.teal(`STEP ${n}`)}  ${c.bold(s.title)}\n          ${c.dim("code:")}  ${s.file}\n`);
    await wait(500);
  }
  const m = await sharp(s.image).metadata();
  process.stdout.write(
    `          ${c.dim("image:")} ${path.relative(path.join(HERE, ".."), s.image).replace(/\\/g, "/")}  ${c.dim(`${m.width}×${m.height}`)}\n`,
  );
  open(s.image);
  process.stdout.write(`          ${c.green("✓ done")}\n`);
  await wait(OPEN ? 1600 : 700);
}

async function main() {
  console.log(c.bold("\n  Personalized storybook — pipeline demo"));
  console.log(c.dim("  one child's photo  →  the child as the character in the story"));
  console.log(c.dim("  (file paths below are ctrl+clickable in the VS Code terminal)\n"));
  await wait(700);

  const book = getBook(STORY_ID);
  const page = book.pages.find((p) => p.id === PAGE_ID);
  if (!page) throw new Error(`Page "${PAGE_ID}" not found in book "${STORY_ID}".`);

  await runStage(1, {
    title: "Input photo — the parent's upload",
    file: "src/routes/sessions.ts",
    image: asset("photo.jpg"),
  });

  await runStage(2, {
    title: "The story page — the illustrator's finished artwork",
    file: "src/pipeline/templates.ts",
    image: page.imagePath,
  });

  await runStage(3, {
    title: "Swap the child into the story — LIVE",
    file: "src/pipeline/personalize.ts",
    image: outFile,
    work: async () => {
      const photo = await readFile(asset("photo.jpg"));
      const swapUri = `data:image/jpeg;base64,${photo.toString("base64")}`;
      // Same call the worker makes — finds the drawn character(s) on the page
      // and swaps each mapped child onto them.
      const finished = await personalizePage(
        page,
        [{ slot: "child_1", photoUrl: swapUri, skinToneHex: null, hairToneHex: null }],
        getTone(book),
      );
      await writeFile(outFile, finished);
    },
  });

  console.log(`\n  ${c.green("✓")} ${c.bold("Finished page")}  ${c.dim("→ demo/output/finished-page.png")}`);
  console.log(c.dim(`  the pose, lighting and art style all come from the artwork — nothing to tune\n`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
