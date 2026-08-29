import Stripe from "stripe";
import { env } from "./env";

// Empty-string fallback matches this codebase's existing pattern (db.ts,
// storage.ts) of letting the process boot without credentials — real calls
// fail clearly at call time instead of crashing at import time.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "");
