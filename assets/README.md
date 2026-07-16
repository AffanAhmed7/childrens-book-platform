# assets

Client-provided and QA assets.

- `templates/` — scene template PNG(s) with defined face regions for compositing.
  `two-children-park.png` is a **placeholder** generated via a free text-to-image Space (no
  real artwork from the client yet) — swap in real art here with no code changes beyond
  updating the slot coordinates in `apps/api/src/pipeline/composite.ts`. See
  [PROJECT_PLAN.md §17](../PROJECT_PLAN.md).
- `style-refs/` — 3–5 illustration style reference images used to tune the portrait model.
  (From client.)
- `test-photos/` — consented/stock child photos for QA only. **Git-ignored** for privacy;
  do not commit real photos of children. (Currently holds the client's Imagitime app
  screenshots, sent as scope reference — not usable as test photos or templates.)

See [PROJECT_PLAN.md §15](../PROJECT_PLAN.md).
