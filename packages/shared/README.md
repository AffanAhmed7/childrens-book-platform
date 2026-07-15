# packages/shared — shared types & copy

Framework-agnostic TypeScript shared between `api` and `web`:
- Session/Character status unions (single source of truth for the status vocabulary)
- Pipeline step names
- User-facing SSE copy strings (proposal wording, i18n-ready)
- API request/response DTOs

Keeps the API, worker, and UI from drifting. To be populated on Day 1.
