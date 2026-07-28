# AgentPlatform

Personal desktop multi-agent collaboration platform. See `docs/specs/2026-07-28-agent-platform-design.md` for the full design.

## Status

**M0 (project skeleton)** — in progress.

## Prerequisites

- Node.js 20 LTS (Node 26+ breaks `better-sqlite3` native build, so stick with 20)
- pnpm 9+
- macOS (arm64 or x64) or Linux (x64). Windows is v2.

## Setup

```bash
git clone <repo>
cd agentplatform
pnpm install
```

The `postinstall` script downloads a pre-built Conduit binary. If it fails (offline), see `docs/dev/conduit-manual.md` for manual placement.

> **Note on `matrix-js-sdk`**: We pin `^31.0.0` (not `^34`). Version 34 ships ESM-only and conflicts with our CommonJS Electron build, so `pnpm install` would fail with `ERR_REQUIRE_ESM`. The lockfile reflects this downgrade.

## Develop

```bash
pnpm dev    # Starts Electron with Vite HMR
```

The app launches, runs onboarding (register a local account), and lands on the empty main shell.

## Test

```bash
pnpm test       # All unit tests (electron + renderer)
pnpm test:e2e   # Full app integration test (slow, requires built app)
```

## Build installer

```bash
pnpm --filter ./electron dist    # Produces .dmg / .AppImage in electron/dist-installers/
```

## Project layout

- `electron/` — Electron main process (Node.js + TypeScript)
- `renderer/` — React UI (Vite)
- `resources/conduit/` — Bundled Conduit binary (downloaded, gitignored)
- `docs/specs/` — Design docs
- `docs/plans/` — Implementation plans
- `docs/dev/` — Contributor setup guides
- `tests/e2e/` — End-to-end integration tests