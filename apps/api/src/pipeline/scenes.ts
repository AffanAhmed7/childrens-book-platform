import path from "node:path";
import type { FaceBox } from "./types";

// The "scene" templates for the repaint→swap→restore→heal recipe (scene.ts).
//
// This is a DIFFERENT engine from templates.ts / personalize.ts. That one swaps
// only the drawn face region and composites it back; this one repaints the whole
// illustration as the child (google/nano-banana), then swaps for identity. The
// repaint is what fixes hair/skin/accessories cohesively (no seams, no halos) —
// see docs/DEMO_PLAN.md. Adding a 4th scene is one entry below.

export interface SceneTemplate {
  id: string;
  imagePath: string;
  // Strips the competitor-app chrome baked into the source pixels (French
  // buttons, the ">" carousel arrow). Verified per-template — see
  // docs/DEMO_PLAN.md "chrome crops".
  crop?: FaceBox;
}

const ASSETS = path.resolve(process.cwd(), "../../assets/templates");

export const SCENES: Record<string, SceneTemplate> = {
  plane: { id: "plane", imagePath: path.join(ASSETS, "temp_2.jpeg"), crop: { left: 0, top: 112, width: 810, height: 649 } },
  astronaut: { id: "astronaut", imagePath: path.join(ASSETS, "temp_1.jpeg"), crop: { left: 0, top: 0, width: 800, height: 750 } },
  workshop: {
    id: "workshop",
    imagePath: path.join(ASSETS, "WhatsApp Image 2026-07-16 at 8.50.37 AM (2).jpeg"),
    crop: { left: 0, top: 0, width: 800, height: 739 },
  },
};

export function getScene(key: string): SceneTemplate {
  const scene = SCENES[key];
  if (!scene) throw new Error(`Unknown scene "${key}". Known: ${Object.keys(SCENES).join(", ")}.`);
  return scene;
}

// The single generic repaint prompt. It works for ANY child because nano-banana
// SEES the photo — there is no per-child hair/skin text. Hardened over the demo
// runs to (a) force the child's real hair length (nano-banana otherwise defaults
// short hair into a bob) and remove template accessories, and (b) match skin tone
// across ALL visible skin so hands/arms don't stay the illustrator's lighter tone.
export const REPAINT_PROMPT = `The first image is a children's book illustration of a child. The second image is a photograph of a real child. Redraw the illustrated child so they clearly and recognisably become the specific child in the photograph.

CHANGE these to match the photograph exactly:
- FACE: same face shape, features, skin tone and proportions as the photo, so it is unmistakably this specific child (keep a warm children's-book expression).
- SKIN TONE: match the child's skin colour from the photo across ALL visible skin — face, ears, neck, hands, fingers and arms. Every visible hand and finger, including ones gripping, holding or touching an object, must be repainted the SAME skin tone as the face. This is the single most common mistake to avoid: do NOT leave hands, fingers or arms paler or a different colour than the face.
- HAIR: give them the SAME hairstyle as in the photograph. Look carefully at the photo and copy the hair's real length, cut, shape, volume, hairline and colour. Match the LENGTH precisely: if the child in the photo has SHORT hair that does not cover the ears or reach the neck, draw short hair that does not cover the ears or reach the neck — do NOT lengthen it into a bob, chin-length or longer style. If the photo shows long hair, draw long hair. If the original illustration has a different hairstyle, or any headband, hair clip, ribbon or hair accessory that this child does NOT have in the photo, REMOVE it completely and redraw the hair from scratch to match the photo. Do not keep the illustration's original hair length or shape.

KEEP everything else identical to the first illustration: the same scene, the same pose and body position, the same clothing (other than hair accessories), the same background, the same composition and camera angle, and the identical soft painterly children's book illustration art style.`;
