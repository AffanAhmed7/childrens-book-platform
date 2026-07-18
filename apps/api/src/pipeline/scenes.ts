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
  // Multi-character templates only — see BookPage.expectedCharacterCount
  // (templates.ts) for what this guards against.
  expectedCharacterCount?: number;
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

// Multi-character counterpart to SCENES, driven by scene.ts's personalizePage
// instead of personalizeBuffer — each entry is 2 photos (left-to-right) onto 2
// drawn characters. No `crop` field here: unlike SCENES (photographed reference
// screenshots that need their competitor chrome stripped), these templates are
// clean illustrator art already at the right framing.
//
// mc_2: verified end-to-end — detectPageCharacters finds exactly the 2 drawn
// characters left-to-right, crop ratios land in the proven range automatically,
// and a real repaint+swap+restore+heal+eyes run succeeds on both characters.
//
// mc_1 was RETIRED 2026-07-19 (template deleted). Its child slot was the page
// that surfaced the aspect-ratio and chibi-artwork swap bugs; the measurements
// taken on it are still cited throughout scene.ts because the crop constants
// were derived from them — those comments are history, not live references.
//
// mc_3: detectPageCharacters finds a 3rd "face" in the rocket ship's window —
// a false positive (MC_3.jpeg only has 2 drawn characters). Confirmed via
// demo/_probe-mc3-windows.mts: only one of the 4 detection windows (the
// left-60%-width crop) finds it, at score 0.874 — plausible-looking
// landmarks, so not geometrically distinguishable from a real face, but lower
// confidence than either real character (0.94, 0.92). Because faces sort
// left-to-right by position and assignment is positional, that 3rd box
// landed in the middle and silently stole the 2nd photo, leaving the real
// 2nd character un-personalized. `expectedCharacterCount: 2` fixes it by
// keeping only the top-2 highest-scoring detections (see
// detectPageCharacters).
export const MULTI_SCENES: Record<string, SceneTemplate> = {
  mc_2: { id: "mc_2", imagePath: path.join(ASSETS, "MC_2.jpeg") },
  mc_3: { id: "mc_3", imagePath: path.join(ASSETS, "MC_3.jpeg"), expectedCharacterCount: 2 },
};

export function getMultiScene(key: string): SceneTemplate {
  const scene = MULTI_SCENES[key];
  if (!scene) throw new Error(`Unknown multi-character scene "${key}". Known: ${Object.keys(MULTI_SCENES).join(", ")}.`);
  return scene;
}

// The single generic repaint prompt. It works for ANY child because nano-banana
// SEES the photo — there is no per-child hair/skin text. Hardened over the demo
// runs to (a) force the child's real hair length (nano-banana otherwise defaults
// short hair into a bob) and remove template accessories, and (b) match skin tone
// across ALL visible skin so hands/arms don't stay the illustrator's lighter tone.
export const REPAINT_PROMPT = `The first image is a children's book illustration of a child. The second image is a photograph of a real child. Redraw the illustrated child so they clearly and recognisably become the specific child in the photograph.

CHANGE these to match the photograph exactly:
- FACE: same face shape, features, skin tone and proportions as the photo, so it is unmistakably this specific child (keep a warm children's-book expression). The face must be anatomically correct and clean: exactly two eyes and exactly one eyebrow per eye, each a single unbroken shape. Do NOT draw a second, faint, offset or overlapping eyebrow above or near the real one, and do NOT draw a second, ghosted or partially-transparent eye near the real one — these are mistakes to actively avoid, not a style choice.
- EYE SIZE (most important): copy the eye size and shape directly from the photograph. Each eye must be roughly ONE FIFTH of the face's width — the proportion in a real human face — and the coloured iris must be a small circle, not a large glossy disc. Large round eyes spanning a third or more of the face width are WRONG. This applies with FULL FORCE to children: a child's eyes in this illustration must be the same realistic size as the child's eyes in the photograph, NOT the large cute cartoon eyes a children's book would normally use, and NOT the eye size in the original illustration. If the original illustration draws this character with big round anime or chibi eyes, deliberately shrink them to realistic human proportions.
- OTHER FACIAL PROPORTIONS: the nose and mouth must be clearly drawn and properly defined, not shrunk to tiny marks, and the head, jaw and cheek shape must follow real human proportions rather than a rounded cartoon ball. Together with the eye rule above this overrides the art-style match below, for facial geometry only.
- SKIN TONE: match the child's skin colour from the photo across ALL visible skin — face, ears, neck, hands, fingers and arms. Every visible hand and finger, including ones gripping, holding or touching an object, must be repainted the SAME skin tone as the face. This is the single most common mistake to avoid: do NOT leave hands, fingers or arms paler or a different colour than the face.
- HAIR: give them the SAME hairstyle as in the photograph. Look carefully at the photo and copy the hair's real length, cut, shape, volume, hairline and colour. Match the LENGTH precisely: if the child in the photo has SHORT hair that does not cover the ears or reach the neck, draw short hair that does not cover the ears or reach the neck — do NOT lengthen it into a bob, chin-length or longer style. If the photo shows long hair, draw long hair. If the original illustration has a different hairstyle, or any headband, hair clip, ribbon or hair accessory that this child does NOT have in the photo, REMOVE it completely and redraw the hair from scratch to match the photo. Do not keep the illustration's original hair length or shape.

KEEP everything else identical to the first illustration: the same scene, the same pose and body position, the same clothing (other than hair accessories), the same background, the same composition and camera angle, and the identical soft painterly children's book illustration art style — except for the facial proportions above, which must stay realistically human even where the original art is more stylised.`;
