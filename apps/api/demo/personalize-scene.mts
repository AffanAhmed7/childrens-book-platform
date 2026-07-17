// Feed ONE kid photo, get the polished scene(s) out — the productionized recipe
// (repaint → swap → restore → auto-heal) from src/pipeline/scene.ts.
//
//   npx tsx demo/personalize-scene.mts <photo> [--scene plane|astronaut|workshop|all] [--out <dir>] [--debug] [--lite]
//
// Default runs ALL scenes (the "connected" flow: one photo → the whole set).
// --debug also writes each intermediate stage (<scene>.repaint/swap/restore/heal.png).
// --lite uses google/nano-banana-2-lite for the repaint stage instead of
// nano-banana, for a side-by-side cost/latency/quality comparison — see
// docs/DEMO_PLAN.md. Output goes to <scene>.lite.png so it never overwrites the
// proven nano-banana result.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCENES, getScene } from "../src/pipeline/scenes";
import { personalizeScene, type RepaintModel } from "../src/pipeline/scene";

const argv = process.argv.slice(2);
const photoPath = argv.find((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const sceneArg = flag("--scene") ?? "all";
const outDir = flag("--out") ?? "demo/output";
const debug = argv.includes("--debug");
const lite = argv.includes("--lite");
const repaintModel: RepaintModel = lite ? "nano-banana-2-lite" : "nano-banana";

if (!photoPath) {
  console.error("usage: npx tsx demo/personalize-scene.mts <photo> [--scene plane|astronaut|workshop|all] [--out <dir>] [--debug] [--lite]");
  process.exit(1);
}

const keys = sceneArg === "all" ? Object.keys(SCENES) : [sceneArg];
const photoBuf = await readFile(photoPath);
const photoExt: "png" | "jpeg" = photoPath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
await mkdir(outDir, { recursive: true });

for (const key of keys) {
  const scene = getScene(key);
  console.log(`\n=== ${key}${lite ? " (nano-banana-2-lite)" : ""} ===`);
  const t0 = Date.now();
  const out = await personalizeScene(scene, photoBuf, photoExt, {
    repaintModel,
    onStage: async (stage, buf) => {
      if (debug) await writeFile(path.join(outDir, `${key}${lite ? ".lite" : ""}.${stage}.png`), buf);
      console.log(`  ${stage}${stage === "heal" ? " (auto-heal)" : ""} ok`);
    },
  });
  const outPath = path.join(outDir, `${key}${lite ? ".lite" : ""}.png`);
  await writeFile(outPath, out);
  console.log(`  -> ${outPath}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log("\ndone");
