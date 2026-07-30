# vaultographiter — Agent Guide

Obsidian vault 3D visualizer: a local Express server scans a Markdown vault
and streams it to a Three.js graph renderer in the browser.

## Project Facts

- Two runnables, one repo:
  - `server/` — Express + WebSocket (`/ws`) + chokidar vault scanner (plain ESM `.mjs`, port 4400).
  - `src/` — Three.js graph visualization client (TypeScript, Vite, port 5173; proxies `/api` and `/ws` to the server).
- Core boundary: `server/` owns vault scanning and the snapshot/patch protocol; `src/` owns rendering, layout, and HUD. `src/types.ts` describes the shared data shapes (`VaultSnapshot`, `Note`, `Edge`, `PatchEvent`), but the server does not import them — keep both sides in sync by hand when changing any payload shape.
- No tests, no lint, no CI. `tsc --noEmit` covers `src/` only (see `tsconfig.json` include).

## Environment

- `VAULT_PATH` (required in practice): absolute path to an existing Obsidian vault directory. Default: `~/Documents/Obsidian`. The server exits at startup if the path does not exist.
- `PORT` (optional): server port, default `4400`.
- See `.env.example` for both variables. Node version pin: see `engines` in `package.json`.

## Commands

- `npm run dev` — start server + client together (concurrently).
- `npm run dev:server` — server only (`node server/index.mjs`).
- `npm run dev:client` — Vite client only.
- `npm run build` — `tsc --noEmit && vite build` (the only mechanical check).

## Decision Rules

- Any change to the snapshot, patch events, or `/api/vault` / `/api/note` responses must be applied to both `server/` and `src/types.ts` in the same change.
- Keep the `/api/note` path-traversal guard intact (`server/index.mjs`): resolved paths must stay inside `VAULT_PATH` and end with `.md`.
- The server reads the user's real vault; never write into `VAULT_PATH` from this codebase.

## Verification

- Run `npm run build` after any `src/` change (type-check + bundle).
- After `server/` changes, start `npm run dev:server` against a valid `VAULT_PATH` and confirm the scan log line and `/api/vault` respond.
