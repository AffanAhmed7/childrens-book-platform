// Feed ONE kid photo, get the polished scene(s) out — the productionized recipe
// (repaint → swap → restore → auto-heal) from src/pipeline/scene.ts.
//
//   npx tsx demo/personalize-scene.mts <photo> [--scene plane|astronaut|workshop|all] [--out <dir>] [--debug]
//
// Default runs ALL scenes (the "connected" flow: one photo → the whole set).
// --debug also writes each intermediate stage (<scene>.repaint/swap/restore/heal.png).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCENES, getScene } from "../src/pipeline/scenes";
import { personalizeScene } from "../src/pipeline/scene";

const argv = process.argv.slice(2);
const photoPath = argv.find((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const sceneArg = flag("--scene") ?? "all";
const outDir = flag("--out") ?? "demo/output";
const debug = argv.includes("--debug");

if (!photoPath) {
  console.error("usage: npx tsx demo/personalize-scene.mts <photo> [--scene plane|astronaut|workshop|all] [--out <dir>] [--debug]");
  process.exit(1);
}

const keys = sceneArg === "all" ? Object.keys(SCENES) : [sceneArg];
const photoBuf = await readFile(photoPath);
const photoExt: "png" | "jpeg" = photoPath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
await mkdir(outDir, { recursive: true });

for (const key of keys) {
  const scene = getScene(key);
  console.log(`\n=== ${key} ===`);
  const t0 = Date.now();
  const out = await personalizeScene(scene, photoBuf, photoExt, {
    onStage: async (stage, buf) => {
      if (debug) await writeFile(path.join(outDir, `${key}.${stage}.png`), buf);
      console.log(`  ${stage}${stage === "heal" ? " (auto-heal)" : ""} ok`);
    },
  });
  const outPath = path.join(outDir, `${key}.png`);
  await writeFile(outPath, out);
  console.log(`  -> ${outPath}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log("\ndone");
