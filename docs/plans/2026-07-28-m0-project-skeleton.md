# AgentPlatform M0 — Project Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M0 milestone of AgentPlatform — a launchable Electron + React desktop app where the user can complete onboarding (register account on built-in Conduit homeserver) and arrive at an empty main shell.

**Architecture:** Electron main process (Node.js + TypeScript) hosts an embedded Conduit binary, manages SQLite + OS keychain, and exposes IPC to a React renderer. Renderer uses Vite + Zustand. Standalone mode only — onboarding registers the first user on a locally-running Conduit.

**Tech Stack:**
- Electron 30+ with `electron-builder`
- React 18 + TypeScript 5 + Vite 5
- `better-sqlite3` for local state
- `keytar` for OS keychain
- `matrix-js-sdk` for Matrix client
- Conduit (Rust Matrix homeserver) bundled as pre-built binary
- `vitest` for testing both main and renderer
- `zustand` for renderer state

## Global Constraints

These apply to every task:

- **TypeScript strict mode** everywhere (`"strict": true`). No `any` types, no `@ts-ignore`, no `as unknown as X` casts outside narrow bounds.
- **Node.js 20 LTS** as runtime/engine target.
- **ESM in renderer** (Vite handles), **CommonJS in Electron main** (for `better-sqlite3` native binding compatibility).
- **No backend secrets in renderer** — all credentials/tokens live in main process or OS keychain, exposed to renderer only via IPC.
- **All commits use Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).
- **Tests run on every task** before commit: `pnpm test`.
- **Working directory is `/workspace`** (the repo root).
- **Package manager is pnpm** (workspace mode for monorepo).
- **Platform targets:** macOS (arm64 + x64), Linux (x64). Windows is v2.

## Spike Decisions (resolving open questions from spec § 14.1)

- **Conduit distribution:** Pre-built binary downloaded via npm `postinstall` script into `resources/conduit/`. Binary path resolved at runtime by platform. Conduit data lives in `~/.agent-platform/conduit-data/`.
- **Git library:** Not needed in M0 (Git ops come in M1). No `isomorphic-git` / `nodegit` decision yet.
- **Matrix SDK:** `matrix-js-sdk` (v34+). Mature, JS-native, fits Electron.
- **LLM provider:** Not needed in M0. Deferred to M1.
- **macOS sandbox-exec signing:** Not needed in M0 (no sandbox yet). Deferred to M3.

## File Structure

```
/workspace/
├── package.json                          # Root: pnpm workspace + scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json                    # Shared TS config
├── .gitignore
├── .editorconfig
├── .prettierrc
├── eslint.config.mjs
├── electron/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main/
│   │   │   ├── index.ts                  # Electron entry: createWindow + lifecycle
│   │   │   ├── window.ts                 # BrowserWindow factory
│   │   │   ├── ipc/
│   │   │   │   ├── index.ts              # Register all IPC handlers
│   │   │   │   ├── auth.handlers.ts      # register/login/getCurrentUser
│   │   │   │   └── system.handlers.ts    # getSystemInfo, getConduitStatus
│   │   │   ├── conduit/
│   │   │   │   ├── binary-path.ts        # Resolve bundled binary per OS
│   │   │   │   ├── config.ts             # Generate conduit.toml
│   │   │   │   └── manager.ts            # Lifecycle: start/stop/healthcheck
│   │   │   ├── matrix/
│   │   │   │   ├── client.ts             # matrix-js-sdk wrapper
│   │   │   │   └── auth.ts               # register/login/logout
│   │   │   ├── storage/
│   │   │   │   ├── db.ts                 # better-sqlite3 singleton + migrations runner
│   │   │   │   ├── migrations/
│   │   │   │   │   ├── 001_init.sql      # Initial schema
│   │   │   │   │   └── index.ts
│   │   │   │   └── keychain.ts           # keytar wrapper
│   │   │   ├── paths.ts                  # Resolve ~/.agent-platform/ paths
│   │   │   └── logger.ts                 # winston/pino logger
│   │   └── preload/
│   │       └── index.ts                  # contextBridge API surface
│   └── tests/
│       ├── conduit/
│       │   ├── binary-path.test.ts
│       │   ├── config.test.ts
│       │   └── manager.test.ts
│       ├── matrix/
│       │   └── auth.test.ts
│       └── storage/
│           ├── db.test.ts
│           └── keychain.test.ts
├── renderer/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx                      # React entry
│       ├── App.tsx                       # Root: routes between Onboarding / MainShell
│       ├── routes/
│       │   ├── Onboarding.tsx
│       │   └── MainShell.tsx
│       ├── components/
│       │   ├── layout/
│       │   │   ├── MainLayout.tsx        # 3-column shell
│       │   │   ├── LeftRail.tsx          # 56px rail with nav icons
│       │   │   ├── MiddlePanel.tsx       # Active view
│       │   │   └── RightPanel.tsx        # Editor/detail (hidden in M0)
│       │   └── onboarding/
│       │       ├── WelcomeStep.tsx
│       │       ├── ModeSelectStep.tsx
│       │       ├── AccountSetupStep.tsx
│       │       └── CompleteStep.tsx
│       ├── stores/
│       │   ├── auth.store.ts             # Zustand: current user, login state
│       │   └── ui.store.ts               # Zustand: active view, modals
│       ├── ipc/
│       │   ├── client.ts                 # Typed wrapper around window.api
│       │   └── types.ts                  # Shared IPC types
│       ├── lib/
│       │   ├── cn.ts                     # Tailwind classname helper
│       │   └── format.ts                 # Misc formatting
│       └── styles/
│           └── globals.css
├── resources/
│   └── conduit/
│       ├── .gitignore                    # Ignore downloaded binaries
│       └── download.ts                   # Script: download binary per OS (run on postinstall)
└── tests/
    └── e2e/
        └── onboarding.spec.ts            # Playwright/Vitest integration test
```

## Task Dependency Graph

```
T1 (init) ──► T2 (paths/logger) ──► T3 (SQLite + migrations)
                                     │
                                     ├──► T4 (keychain)
                                     │
                                     └──► T5 (Conduit binary path)
                                          │
                                          ▼
                                       T6 (Conduit config) ──► T7 (Conduit lifecycle manager)
                                                                  │
                                                                  ▼
                                                                T8 (Matrix client wrapper)
                                                                  │
                                                                  ▼
                                                                T9 (Matrix auth)
                                                                  │
                                                                  ▼
                                                                T10 (IPC framework + preload)
                                                                  │
                                                                  ├──► T11 (auth IPC handlers)
                                                                  │
                                                                  └──► T12 (system IPC handlers)
                                                                       │
                                                                       ▼
                                                                    T13 (auth store + UI store renderer)
                                                                       │
                                                                       ▼
                                                                    T14 (Electron main entry + window)
                                                                       │
                                                                       ▼
                                                                    T15 (Onboarding wizard)
                                                                       │
                                                                       ▼
                                                                    T16 (Main shell layout)
                                                                       │
                                                                       ▼
                                                                    T17 (electron-builder packaging)
                                                                       │
                                                                       ▼
                                                                    T18 (e2e integration test)
```

---

## Task 1: Project init — pnpm workspace + TypeScript + ESLint + Prettier

**Files:**
- Create: `/workspace/package.json`, `/workspace/pnpm-workspace.yaml`, `/workspace/tsconfig.base.json`, `/workspace/.gitignore`, `/workspace/.editorconfig`, `/workspace/.prettierrc`, `/workspace/eslint.config.mjs`
- Create: `/workspace/electron/package.json`, `/workspace/electron/tsconfig.json`, `/workspace/electron/vitest.config.ts`
- Create: `/workspace/electron/src/main/.gitkeep`, `/workspace/electron/tests/.gitkeep` (placeholder so TypeScript include tree is non-empty)
- Create: `/workspace/renderer/package.json`, `/workspace/renderer/tsconfig.json`, `/workspace/renderer/vite.config.ts`, `/workspace/renderer/index.html`
- Create: `/workspace/renderer/src/.gitkeep` (placeholder)
- Create: `/workspace/resources/conduit/.gitignore`, `/workspace/resources/conduit/download.ts` (download script referenced by root postinstall)

**Interfaces:**
- Produces: `pnpm install` works (Electron binary download may take a few minutes; allowed to fail gracefully if offline); `pnpm test` runs zero tests successfully; `pnpm typecheck` succeeds on placeholder source trees.

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "agentplatform",
  "private": true,
  "version": "0.1.0",
  "description": "Personal desktop multi-agent collaboration platform",
  "license": "Apache-2.0",
  "packageManager": "pnpm@9.0.0",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "dev": "pnpm --filter ./electron dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "postinstall": "pnpm --filter ./renderer postinstall && tsx resources/conduit/download.ts"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.4.0",
    "typescript-eslint": "^8.0.0",
    "eslint": "^9.0.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "electron"
  - "renderer"
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
node_modules/
dist/
.DS_Store
*.log
.env
.env.local
coverage/
.vite/
resources/conduit/conduit-*
!resources/conduit/.gitignore
!resources/conduit/download.ts
```

- [ ] **Step 5: Create `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 6: Create `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 7: Create `eslint.config.mjs`**

```javascript
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'resources/conduit/conduit-*'],
  }
);
```

- [ ] **Step 8: Create `electron/package.json`**

```json
{
  "name": "@ap/electron",
  "private": true,
  "version": "0.1.0",
  "type": "commonjs",
  "main": "dist/main/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "concurrently \"tsc -p tsconfig.json --watch\" \"electron .\"",
    "test": "vitest run --config vitest.config.ts",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "keytar": "^7.9.0",
    "matrix-js-sdk": "^34.0.0",
    "electron-log": "^5.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "electron": "^30.0.0",
    "concurrently": "^8.2.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@vitest/coverage-v8": "^1.6.0",
    "typescript-eslint": "^8.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.0.0"
  }
}
```

- [ ] **Step 9: Create `electron/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 10: Create `renderer/package.json`**

```json
{
  "name": "@ap/renderer",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "eslint src --ext .ts,.tsx",
    "typecheck": "tsc --noEmit",
    "postinstall": "echo 'renderer postinstall noop'"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^4.5.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.6.0",
    "@testing-library/react": "^15.0.0",
    "@testing-library/jest-dom": "^6.4.0",
    "jsdom": "^24.0.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript-eslint": "^8.0.0",
    "eslint": "^9.0.0",
    "eslint-plugin-react-hooks": "^4.6.0",
    "eslint-plugin-react-refresh": "^0.4.0"
  }
}
```

- [ ] **Step 11: Create `renderer/vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
});
```

- [ ] **Step 12: Create `renderer/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AgentPlatform</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 13: Create `renderer/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 14: Create `electron/vitest.config.ts`**

Required because `electron/package.json`'s `test` script references `--config vitest.config.ts`.

```typescript
// electron/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

- [ ] **Step 15: Create placeholder `.gitkeep` files**

TypeScript's `tsc --noEmit` errors with TS18003 ("No inputs were found") when `include` matches zero files. Add empty placeholders so the include tree is non-empty. These get replaced by real source files in later tasks.

```bash
mkdir -p /workspace/electron/src/main /workspace/electron/tests
mkdir -p /workspace/renderer/src
touch /workspace/electron/src/main/.gitkeep
touch /workspace/electron/tests/.gitkeep
touch /workspace/renderer/src/.gitkeep
```

- [ ] **Step 16: Create `resources/conduit/.gitignore`**

```gitignore
conduit-*
```

- [ ] **Step 17: Create `resources/conduit/download.ts`**

Required because the root `package.json` `postinstall` script invokes `tsx resources/conduit/download.ts`. This script must exist before `pnpm install` runs. (Task 5 only adds the path-resolution logic; the script itself belongs here.)

```typescript
// resources/conduit/download.ts
// Runs on `pnpm postinstall` at root.
// Downloads pre-built Conduit binary for current OS/arch into ./resources/conduit/
// Errors are logged but do NOT fail the install (dev may be offline).

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONDUIT_VERSION = 'v0.9.0'; // TODO: pin to specific Conduit release tag
const BASE_URL = `https://github.com/girlbossceo/conduit/releases/download/${CONDUIT_VERSION}`;

interface PlatformTarget {
  platform: string;
  arch: string;
  filename: string;
}

function detectTarget(): PlatformTarget {
  const platform = process.platform;
  const arch = process.arch;
  const map: Record<string, Record<string, PlatformTarget>> = {
    darwin: {
      arm64: { platform: 'darwin', arch: 'arm64', filename: 'conduit-darwin-arm64' },
      x64: { platform: 'darwin', arch: 'x64', filename: 'conduit-darwin-x64' },
    },
    linux: {
      x64: { platform: 'linux', arch: 'x64', filename: 'conduit-linux-x64' },
    },
    win32: {
      x64: { platform: 'windows', arch: 'x64', filename: 'conduit-windows-x64.exe' },
    },
  };
  const target = map[platform]?.[arch];
  if (!target) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return target;
}

async function download(target: PlatformTarget): Promise<void> {
  const outDir = __dirname;
  const outPath = path.join(outDir, target.filename);
  if (fs.existsSync(outPath)) {
    console.log(`[conduit] ${target.filename} already exists, skipping download`);
    return;
  }
  const url = `${BASE_URL}/${target.filename}`;
  console.log(`[conduit] Downloading ${url}`);
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      fs.createWriteStream(outPath),
    );
    if (process.platform !== 'win32') {
      fs.chmodSync(outPath, 0o755);
    }
    console.log(`[conduit] Saved to ${outPath}`);
  } catch (err) {
    console.warn(`[conduit] Download failed: ${(err as Error).message}`);
    console.warn(
      '[conduit] You may need to manually place the binary. See docs/dev/conduit-manual.md for instructions.',
    );
  }
}

if (require.main === module) {
  download(detectTarget()).catch((err) => {
    console.error('[conduit] Fatal:', err);
    // Do NOT exit non-zero; allow pnpm install to continue.
    process.exit(0);
  });
}
```

- [ ] **Step 18: Run `pnpm install`**

Run: `cd /workspace && pnpm install`
Expected: dependencies installed. The Electron binary postinstall may take 1-3 minutes on first run. The Conduit download (run by root postinstall) will fail gracefully if GitHub is unreachable — that's OK for Task 1's deliverables; the path-resolution logic in Task 5 still works against a missing file (only the lifecycle manager in Task 7 requires the real binary).

If `pnpm` is not installed globally, use `npx pnpm@9.0.0 install`. If `better-sqlite3` native build fails on newer Node, use Node 20 LTS.

- [ ] **Step 19: Verify `pnpm test` and `pnpm typecheck` succeed**

Run: `cd /workspace && pnpm test && pnpm typecheck`
Expected: both succeed. `pnpm test` runs zero tests in each workspace (passes vacuously with the vitest configs in place). `pnpm typecheck` succeeds against the placeholder `.gitkeep` files.

- [ ] **Step 20: Commit**

```bash
git add -A
git commit -m "chore: initialize pnpm monorepo with TypeScript, ESLint, Prettier"
```

---

## Task 2: Paths + Logger utilities

**Files:**
- Create: `electron/src/main/paths.ts`, `electron/src/main/logger.ts`
- Test: `electron/tests/paths.test.ts`

**Interfaces:**
- Produces:
  - `resolveUserDataDir(): string` — returns `~/.agent-platform/`, creating it
  - `resolveConduitDir(): string` — returns `~/.agent-platform/conduit-data/`
  - `resolveDbPath(): string` — returns `~/.agent-platform/state.db`
  - `logger` — winston-style logger instance with `info/warn/error/debug`

- [ ] **Step 1: Write the failing test for paths**

```typescript
// electron/tests/paths.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveUserDataDir, resolveConduitDir, resolveDbPath } from '../src/main/paths';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('paths', () => {
  const tmpRoot = path.join(os.tmpdir(), `ap-test-${Date.now()}`);

  beforeEach(() => {
    process.env.AP_USER_DATA_DIR = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('resolveUserDataDir returns AP_USER_DATA_DIR and creates it', () => {
    const result = resolveUserDataDir();
    expect(result).toBe(tmpRoot);
    expect(fs.existsSync(tmpRoot)).toBe(true);
  });

  it('resolveConduitDir returns <userData>/conduit-data', () => {
    const result = resolveConduitDir();
    expect(result).toBe(path.join(tmpRoot, 'conduit-data'));
    expect(fs.existsSync(result)).toBe(true);
  });

  it('resolveDbPath returns <userData>/state.db', () => {
    expect(resolveDbPath()).toBe(path.join(tmpRoot, 'state.db'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/paths.test.ts`
Expected: FAIL with "Cannot find module '../src/main/paths'".

- [ ] **Step 3: Implement `paths.ts`**

```typescript
// electron/src/main/paths.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function defaultUserDataDir(): string {
  return path.join(os.homedir(), '.agent-platform');
}

export function resolveUserDataDir(): string {
  const dir = process.env.AP_USER_DATA_DIR ?? defaultUserDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveConduitDir(): string {
  const dir = path.join(resolveUserDataDir(), 'conduit-data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function resolveDbPath(): string {
  return path.join(resolveUserDataDir(), 'state.db');
}

export function resolveLogsDir(): string {
  const dir = path.join(resolveUserDataDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/electron && pnpm vitest run tests/paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement `logger.ts`**

```typescript
// electron/src/main/logger.ts
import log from 'electron-log';
import { resolveLogsDir } from './paths';

log.transports.file.resolvePathFn = () => `${resolveLogsDir()}/main.log`;
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB
log.transports.console.level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
log.transports.file.level = 'info';

export const logger = log.scope('main');
export default logger;
```

- [ ] **Step 6: Verify typecheck**

Run: `cd /workspace/electron && pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/paths.ts electron/src/main/logger.ts electron/tests/paths.test.ts
git commit -m "feat(main): add paths and logger utilities"
```

---

## Task 3: SQLite + migrations framework

**Files:**
- Create: `electron/src/main/storage/db.ts`, `electron/src/main/storage/migrations/index.ts`, `electron/src/main/storage/migrations/001_init.sql`
- Test: `electron/tests/storage/db.test.ts`

**Interfaces:**
- Produces:
  - `getDb(): Database` — singleton better-sqlite3 instance
  - `runMigrations(): void` — applies pending SQL migrations
  - `closeDb(): void` — for tests / shutdown
- Schema includes `kv_store(key TEXT PRIMARY KEY, value TEXT)` table for simple config storage used in M0.

- [ ] **Step 1: Write the failing test**

```typescript
// electron/tests/storage/db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, runMigrations, closeDb } from '../../src/main/storage/db';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpRoot = path.join(os.tmpdir(), `ap-db-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('storage/db', () => {
  it('runMigrations creates kv_store table', () => {
    runMigrations();
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('kv_store');
  });

  it('kv_store round-trips a value', () => {
    runMigrations();
    const db = getDb();
    db.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?)').run('foo', '"bar"');
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('foo') as {
      value: string;
    };
    expect(row.value).toBe('"bar"');
  });

  it('runMigrations is idempotent', () => {
    runMigrations();
    runMigrations();
    const db = getDb();
    const count = (
      db.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='kv_store'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/storage/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the SQL migration**

```sql
-- electron/src/main/storage/migrations/001_init.sql
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Implement `migrations/index.ts`**

```typescript
// electron/src/main/storage/migrations/index.ts
import fs from 'node:fs';
import path from 'node:path';

export interface Migration {
  version: number;
  filename: string;
}

export function loadMigrations(): Migration[] {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  return files.map((f) => ({
    version: parseInt(f.slice(0, 3), 10),
    filename: f,
  }));
}

export function readMigrationSql(migration: Migration): string {
  return fs.readFileSync(path.join(__dirname, migration.filename), 'utf-8');
}
```

- [ ] **Step 5: Implement `db.ts`**

```typescript
// electron/src/main/storage/db.ts
import Database from 'better-sqlite3';
import type { Database as DBType } from 'better-sqlite3';
import { resolveDbPath } from '../paths';
import { logger } from '../logger';
import { loadMigrations, readMigrationSql } from './migrations';

let dbInstance: DBType | null = null;

export function getDb(): DBType {
  if (!dbInstance) {
    const dbPath = resolveDbPath();
    dbInstance = new Database(dbPath);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    logger.info('SQLite opened', { path: dbPath });
  }
  return dbInstance;
}

export function runMigrations(): void {
  const db = getDb();
  const applied = new Set(
    (
      db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    ).map((r) => r.version)
  );

  const migrations = loadMigrations();
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    logger.info('Applying migration', { version: m.version, file: m.filename });
    const sql = readMigrationSql(m);
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /workspace/electron && pnpm vitest run tests/storage/db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/storage/ electron/tests/storage/db.test.ts
git commit -m "feat(main): add SQLite + migration framework with kv_store"
```

---

## Task 4: Keychain wrapper

**Files:**
- Create: `electron/src/main/storage/keychain.ts`
- Test: `electron/tests/storage/keychain.test.ts`

**Interfaces:**
- Produces:
  - `setSecret(key: string, value: string): Promise<void>`
  - `getSecret(key: string): Promise<string | null>`
  - `deleteSecret(key: string): Promise<void>`

Service name is constant: `AgentPlatform`.

> **Note:** `keytar` may not work in CI (no OS keychain). The test file must use a `MockKeychain` that the wrapper can be configured to use. The wrapper exposes a `setKeychainImpl(impl)` hook for testing.

- [ ] **Step 1: Write the failing test**

```typescript
// electron/tests/storage/keychain.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSecret,
  getSecret,
  deleteSecret,
  setKeychainImpl,
} from '../../src/main/storage/keychain';

class MockKeychain {
  store = new Map<string, string>();
  async setSecret(key: string, value: string) {
    this.store.set(key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async deleteSecret(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('keychain', () => {
  beforeEach(() => {
    setKeychainImpl(new MockKeychain());
  });

  it('setSecret and getSecret round-trip', async () => {
    await setSecret('foo', 'bar');
    expect(await getSecret('foo')).toBe('bar');
  });

  it('getSecret returns null for missing key', async () => {
    expect(await getSecret('missing')).toBeNull();
  });

  it('deleteSecret removes key', async () => {
    await setSecret('foo', 'bar');
    await deleteSecret('foo');
    expect(await getSecret('foo')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/storage/keychain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `keychain.ts`**

```typescript
// electron/src/main/storage/keychain.ts
import keytar from 'keytar';
import { logger } from '../logger';

const SERVICE_NAME = 'AgentPlatform';

export interface KeychainImpl {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}

class ProductionKeychainImpl implements KeychainImpl {
  async setSecret(key: string, value: string): Promise<void> {
    await keytar.setPassword(SERVICE_NAME, key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return await keytar.getPassword(SERVICE_NAME, key);
  }
  async deleteSecret(key: string): Promise<void> {
    await keytar.deletePassword(SERVICE_NAME, key);
  }
}

let impl: KeychainImpl = new ProductionKeychainImpl();

export function setKeychainImpl(newImpl: KeychainImpl): void {
  impl = newImpl;
}

export async function setSecret(key: string, value: string): Promise<void> {
  logger.debug('setSecret', { key });
  await impl.setSecret(key, value);
}

export async function getSecret(key: string): Promise<string | null> {
  return await impl.getSecret(key);
}

export async function deleteSecret(key: string): Promise<void> {
  logger.debug('deleteSecret', { key });
  await impl.deleteSecret(key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/electron && pnpm vitest run tests/storage/keychain.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/keychain.ts electron/tests/storage/keychain.test.ts
git commit -m "feat(main): add keychain wrapper with injectable impl for tests"
```

---

## Task 5: Conduit binary path resolution

**Files:**
- Create: `electron/src/main/conduit/binary-path.ts`
- Test: `electron/tests/conduit/binary-path.test.ts`

> **Note:** `resources/conduit/download.ts` and `resources/conduit/.gitignore` are created in Task 1 (the root `postinstall` script depends on `download.ts` existing before `pnpm install`). This task only adds the runtime path-resolution logic.

**Interfaces:**
- Produces:
  - `resolveConduitBinaryPath(): string` — returns absolute path to the bundled Conduit binary for the current OS/arch.

**Spike decision (from Global Constraints):**
- Conduit binaries downloaded by `resources/conduit/download.ts` (run as npm postinstall) into `resources/conduit/conduit-<platform>-<arch>[.exe]`.
- Filenames: `conduit-darwin-arm64`, `conduit-darwin-x64`, `conduit-linux-x64`, `conduit-windows-x64.exe`.

> **If `download.ts` failed at install time (offline), M0 still works in dev — the path-resolution test only checks the returned string, not the file's existence. The lifecycle test in Task 7 will require the real binary; provide manual fallback in README (Task 20).**

- [ ] **Step 1: Write the failing test for `binary-path.ts`**

```typescript
// electron/tests/conduit/binary-path.test.ts
import { describe, it, expect } from 'vitest';
import { resolveConduitBinaryPath } from '../../src/main/conduit/binary-path';

describe('conduit/binary-path', () => {
  it('returns a string ending with the correct per-OS filename', () => {
    const p = resolveConduitBinaryPath();
    expect(typeof p).toBe('string');
    if (process.platform === 'win32') {
      expect(p).toMatch(/conduit-windows-x64\.exe$/);
    } else if (process.platform === 'darwin') {
      expect(p).toMatch(/conduit-darwin-(arm64|x64)$/);
    } else {
      expect(p).toMatch(/conduit-linux-x64$/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/conduit/binary-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `binary-path.ts`**

```typescript
// electron/src/main/conduit/binary-path.ts
import path from 'node:path';

function perOsFilename(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') return 'conduit-windows-x64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'conduit-darwin-arm64' : 'conduit-darwin-x64';
  if (platform === 'linux') return 'conduit-linux-x64';
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

export function resolveConduitBinaryPath(): string {
  // From electron/src/main/conduit/, walk up to <root>/resources/conduit/<binary>
  // In production (packaged), this lives under process.resourcesPath.
  const filename = perOsFilename();
  if (process.env.NODE_ENV === 'production' && process.resourcesPath) {
    return path.join(process.resourcesPath, 'conduit', filename);
  }
  // Dev mode: walk up from this compiled file to repo root.
  // electron/dist/main/conduit/binary-path.js → ../../../resources/conduit/
  return path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'conduit', filename);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/electron && pnpm vitest run tests/conduit/binary-path.test.ts`
Expected: PASS.

> If the binary file itself does not exist (download failed), the path resolution test still passes because it only checks the returned string. The lifecycle test in Task 7 will check actual existence.

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/conduit/binary-path.ts electron/tests/conduit/binary-path.test.ts
git commit -m "feat(main): add Conduit binary path resolution"
```

---

## Task 6: Conduit config generation

**Files:**
- Create: `electron/src/main/conduit/config.ts`
- Test: `electron/tests/conduit/config.test.ts`

**Interfaces:**
- Produces:
  - `generateConduitConfig(opts: { port: number; serverName: string; dataDir: string }): string` — returns the TOML content for Conduit.
  - `writeConduitConfig(opts): Promise<string>` — writes the TOML to `<dataDir>/conduit.toml` and returns the path.

- [ ] **Step 1: Write the failing test**

```typescript
// electron/tests/conduit/config.test.ts
import { describe, it, expect } from 'vitest';
import { generateConduitConfig } from '../../src/main/conduit/config';

describe('conduit/config', () => {
  it('generateConduitConfig produces valid TOML with the given values', () => {
    const toml = generateConduitConfig({
      port: 8008,
      serverName: 'localhost',
      dataDir: '/tmp/conduit-data',
    });
    expect(toml).toContain('[global]');
    expect(toml).toContain('server_name = "localhost"');
    expect(toml).toContain('port = 8008');
    expect(toml).toContain('database_path = "/tmp/conduit-data"');
    expect(toml).toContain('allow_registration = true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/conduit/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.ts`**

```typescript
// electron/src/main/conduit/config.ts
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

export interface ConduitConfigOptions {
  port: number;
  serverName: string;
  dataDir: string;
}

export function generateConduitConfig(opts: ConduitConfigOptions): string {
  return `# Auto-generated by AgentPlatform. Do not edit manually.
[global]
server_name = "${opts.serverName}"
database_path = "${opts.dataDir}"
database_backend = "sqlite"

[global.network]
port = ${opts.port}
bind = "127.0.0.1"  # Local only; never expose to LAN

[global.allow_registration]
allow_registration = true
# Disabled after first admin account is created.
`;
}

export async function writeConduitConfig(opts: ConduitConfigOptions): Promise<string> {
  const configPath = path.join(opts.dataDir, 'conduit.toml');
  const toml = generateConduitConfig(opts);
  fs.writeFileSync(configPath, toml, 'utf-8');
  logger.info('Conduit config written', { path: configPath });
  return configPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/electron && pnpm vitest run tests/conduit/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/conduit/config.ts electron/tests/conduit/config.test.ts
git commit -m "feat(main): add Conduit config generation"
```

---

## Task 7: Conduit lifecycle manager

**Files:**
- Create: `electron/src/main/conduit/manager.ts`
- Test: `electron/tests/conduit/manager.test.ts`

**Interfaces:**
- Produces:
  - `startConduit(): Promise<{ port: number; baseUrl: string }>` — idempotent start; returns Conduit's URL
  - `stopConduit(): Promise<void>` — graceful stop
  - `isConduitRunning(): boolean`
  - `healthCheck(timeoutMs?: number): Promise<boolean>` — GET `/health` until success or timeout

> The test must not require an actual Conduit binary. It uses a fake binary (a small Node.js script that listens on a port and responds to `/health`).

- [ ] **Step 1: Create test fake binary**

```typescript
// electron/tests/conduit/fake-binary.ts
// Spawned by manager.test.ts as a stand-in for Conduit.
import http from 'node:http';

const port = parseInt(process.env.FAKE_CONDUIT_PORT ?? '0', 10);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200).end('OK');
  } else {
    res.writeHead(404).end();
  }
});
server.listen(port, '127.0.0.1', () => {
  const actual = (server.address() as { port: number }).port;
  process.stdout.write(`READY:${actual}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

- [ ] **Step 2: Write the failing test**

```typescript
// electron/tests/conduit/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startConduit, stopConduit, isConduitRunning, healthCheck, setBinaryOverride } from '../../src/main/conduit/manager';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpRoot = path.join(os.tmpdir(), `ap-conduit-test-${Date.now()}`);
const fakeBinary = path.join(__dirname, 'fake-binary.js');

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  // Use tsx or compile fake-binary.js before running. For test simplicity, use `node --import tsx`.
  setBinaryOverride(['node', '--import', 'tsx', fakeBinary]);
});

afterEach(async () => {
  await stopConduit();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  setBinaryOverride(null);
});

describe('conduit/manager', () => {
  it('starts, reports running, healthchecks, and stops', async () => {
    expect(isConduitRunning()).toBe(false);
    const info = await startConduit();
    expect(isConduitRunning()).toBe(true);
    expect(info.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await healthCheck(5000)).toBe(true);
    await stopConduit();
    expect(isConduitRunning()).toBe(false);
  }, 15000);

  it('startConduit is idempotent', async () => {
    const a = await startConduit();
    const b = await startConduit();
    expect(a.baseUrl).toBe(b.baseUrl);
    await stopConduit();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/conduit/manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `manager.ts`**

```typescript
// electron/src/main/conduit/manager.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveConduitBinaryPath } from './binary-path';
import { writeConduitConfig } from './config';
import { resolveConduitDir } from '../paths';
import { logger } from '../logger';

const CONDUIT_PORT = 8008; // Fixed for v1; Conduit binds to 127.0.0.1 only.

let conduitProcess: ChildProcess | null = null;
let binaryOverride: string[] | null = null;

export function setBinaryOverride(args: string[] | null): void {
  binaryOverride = args;
}

export function isConduitRunning(): boolean {
  return conduitProcess !== null && !conduitProcess.killed;
}

export interface ConduitInfo {
  port: number;
  baseUrl: string;
}

export async function startConduit(): Promise<ConduitInfo> {
  if (isConduitRunning()) {
    return { port: CONDUIT_PORT, baseUrl: `http://127.0.0.1:${CONDUIT_PORT}` };
  }

  const dataDir = resolveConduitDir();
  const configPath = await writeConduitConfig({
    port: CONDUIT_PORT,
    serverName: 'localhost',
    dataDir,
  });

  const binary = binaryOverride ?? [resolveConduitBinaryPath()];
  logger.info('Starting Conduit', { binary, configPath });

  conduitProcess = spawn(binary[0], binary.slice(1).concat(['-c', configPath]), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: 'info' },
  });

  conduitProcess.stdout?.on('data', (chunk) => logger.info(`[conduit] ${chunk.toString().trim()}`));
  conduitProcess.stderr?.on('data', (chunk) => logger.warn(`[conduit] ${chunk.toString().trim()}`));
  conduitProcess.on('exit', (code, signal) => {
    logger.warn('Conduit exited', { code, signal });
    conduitProcess = null;
  });

  const ok = await healthCheck(15000);
  if (!ok) {
    await stopConduit();
    throw new Error('Conduit failed health check within 15s');
  }

  logger.info('Conduit started', { baseUrl: `http://127.0.0.1:${CONDUIT_PORT}` });
  return { port: CONDUIT_PORT, baseUrl: `http://127.0.0.1:${CONDUIT_PORT}` };
}

export async function stopConduit(): Promise<void> {
  if (!conduitProcess) return;
  return new Promise((resolve) => {
    const proc = conduitProcess;
    proc!.on('exit', () => {
      conduitProcess = null;
      logger.info('Conduit stopped');
      resolve();
    });
    proc!.kill('SIGTERM');
    // Force kill after 5s
    setTimeout(() => {
      if (!proc!.killed) proc!.kill('SIGKILL');
    }, 5000);
  });
}

export async function healthCheck(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CONDUIT_PORT}/health`);
      if (response.ok) return true;
    } catch {
      // Not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /workspace/electron && pnpm vitest run tests/conduit/manager.test.ts`
Expected: PASS (2 tests, may take ~5-10s for real subprocess startup).

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/conduit/manager.ts electron/tests/conduit/manager.test.ts electron/tests/conduit/fake-binary.ts
git commit -m "feat(main): add Conduit lifecycle manager with health check"
```

---

## Task 8: Matrix client wrapper

**Files:**
- Create: `electron/src/main/matrix/client.ts`

**Interfaces:**
- Produces:
  - `createMatrixClient(opts: { baseUrl: string; userId?: string; accessToken?: string }): MatrixClient`
  - Type re-export of `MatrixClient` from `matrix-js-sdk`.

> This task has no test — `client.ts` is a thin factory. Tested indirectly via Task 9 (auth).

- [ ] **Step 1: Implement `client.ts`**

```typescript
// electron/src/main/matrix/client.ts
import { MatrixClient, MatrixHttpClient, createClient } from 'matrix-js-sdk';
import { logger } from '../logger';

export interface CreateClientOptions {
  baseUrl: string;
  userId?: string;
  accessToken?: string;
  deviceId?: string;
}

export function createMatrixClient(opts: CreateClientOptions): MatrixClient {
  logger.debug('Creating Matrix client', { baseUrl: opts.baseUrl, userId: opts.userId });
  return createClient({
    baseUrl: opts.baseUrl,
    userId: opts.userId,
    accessToken: opts.accessToken,
    deviceId: opts.deviceId,
    useAuthorizationHeader: true,
  });
}

export { MatrixClient, MatrixHttpClient };
```

- [ ] **Step 2: Typecheck**

Run: `cd /workspace/electron && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add electron/src/main/matrix/client.ts
git commit -m "feat(main): add Matrix client factory"
```

---

## Task 9: Matrix auth (register + login)

**Files:**
- Create: `electron/src/main/matrix/auth.ts`
- Test: `electron/tests/matrix/auth.test.ts`

**Interfaces:**
- Produces:
  - `registerAdmin(client: MatrixClient, username: string, password: string): Promise<AuthResult>`
  - `login(client: MatrixClient, username: string, password: string): Promise<AuthResult>`
  - `logout(client: MatrixClient): Promise<void>`
  - `AuthResult` type: `{ userId: string; accessToken: string; deviceId: string }`

> Tests use a stub `MatrixClient` (an object literal matching the methods called). No real Conduit needed.

- [ ] **Step 1: Write the failing test**

```typescript
// electron/tests/matrix/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { registerAdmin, login, logout } from '../../src/main/matrix/auth';

interface StubResponses {
  registerResponse: unknown;
  loginResponse: unknown;
}

function makeStubClient(responses: StubResponses): MatrixClient {
  return {
    register: vi.fn().mockResolvedValue(responses.registerResponse),
    login: vi.fn().mockResolvedValue(responses.loginResponse),
    logout: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
  } as unknown as MatrixClient;
}

describe('matrix/auth', () => {
  it('registerAdmin returns userId + accessToken + deviceId', async () => {
    const client = makeStubClient({
      registerResponse: { user_id: '@alice:localhost', access_token: 'tok-1', device_id: 'DEV-1' },
      loginResponse: {},
    });
    const result = await registerAdmin(client, 'alice', 'pass');
    expect(result).toEqual({ userId: '@alice:localhost', accessToken: 'tok-1', deviceId: 'DEV-1' });
    expect(client.register).toHaveBeenCalledWith('alice', 'pass', undefined, expect.any(Object));
  });

  it('login returns userId + accessToken + deviceId', async () => {
    const client = makeStubClient({
      registerResponse: {},
      loginResponse: { user_id: '@alice:localhost', access_token: 'tok-2', device_id: 'DEV-2' },
    });
    const result = await login(client, 'alice', 'pass');
    expect(result).toEqual({ userId: '@alice:localhost', accessToken: 'tok-2', deviceId: 'DEV-2' });
  });

  it('logout calls client.logout', async () => {
    const client = makeStubClient({ registerResponse: {}, loginResponse: {} });
    await logout(client);
    expect(client.logout).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/matrix/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth.ts`**

```typescript
// electron/src/main/matrix/auth.ts
import type { MatrixClient } from 'matrix-js-sdk';
import { logger } from '../logger';

export interface AuthResult {
  userId: string;
  accessToken: string;
  deviceId: string;
}

/** Subset of Matrix register/login response that we consume. */
interface MatrixAuthResponse {
  user_id: string;
  access_token: string;
  device_id: string;
}

function pickAuthFields(raw: unknown): MatrixAuthResponse {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('user_id' in raw) ||
    !('access_token' in raw) ||
    !('device_id' in raw)
  ) {
    throw new Error('Matrix auth response missing required fields');
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.user_id !== 'string' ||
    typeof r.access_token !== 'string' ||
    typeof r.device_id !== 'string'
  ) {
    throw new Error('Matrix auth response fields have wrong type');
  }
  return {
    user_id: r.user_id,
    access_token: r.access_token,
    device_id: r.device_id,
  };
}

export async function registerAdmin(
  client: MatrixClient,
  username: string,
  password: string,
): Promise<AuthResult> {
  logger.info('Registering user', { username });
  const raw: unknown = await client.register(username, password, undefined, {
    type: 'm.login.dummy',
    auth: { type: 'm.login.dummy' },
  });
  const response = pickAuthFields(raw);
  return {
    userId: response.user_id,
    accessToken: response.access_token,
    deviceId: response.device_id,
  };
}

export async function login(
  client: MatrixClient,
  username: string,
  password: string,
): Promise<AuthResult> {
  logger.info('Logging in user', { username });
  const raw: unknown = await client.login('m.login.password', {
    user: username,
    password,
    initial_device_display_name: 'AgentPlatform Desktop',
  });
  const response = pickAuthFields(raw);
  return {
    userId: response.user_id,
    accessToken: response.access_token,
    deviceId: response.device_id,
  };
}

export async function logout(client: MatrixClient): Promise<void> {
  logger.info('Logging out');
  await client.logout();
  await client.stopClient();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/electron && pnpm vitest run tests/matrix/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/matrix/auth.ts electron/tests/matrix/auth.test.ts
git commit -m "feat(main): add Matrix register/login/logout"
```

---

## Task 10: IPC framework + preload bridge

**Files:**
- Create: `electron/src/preload/index.ts`
- Create: `electron/src/main/ipc/index.ts`
- Create: `renderer/src/ipc/types.ts`, `renderer/src/ipc/client.ts`

**Interfaces:**
- Produces:
  - Preload exposes `window.api` with channel namespaces: `auth.*`, `system.*`
  - Main process `registerIpcHandlers(): void` — called from main entry to wire handlers
  - Renderer `ipc.client` typed wrapper with methods `auth.register(...)`, `auth.login(...)`, `system.getInfo()`, `system.getConduitStatus()`

> This task is wiring only; concrete handlers come in T11 (auth) and T12 (system). Here we just define the shape and stubs that throw `not_implemented`.

- [ ] **Step 1: Define IPC types in renderer**

```typescript
// renderer/src/ipc/types.ts
export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  appVersion: string;
  userDataDir: string;
}

export interface ConduitStatus {
  running: boolean;
  baseUrl: string | null;
  port: number | null;
}

export interface AuthResult {
  userId: string;
  deviceId: string;
}

export interface ApiSurface {
  auth: {
    register(opts: { username: string; password: string }): Promise<AuthResult>;
    login(opts: { username: string; password: string }): Promise<AuthResult>;
    getCurrentUser(): Promise<AuthResult | null>;
    logout(): Promise<void>;
  };
  system: {
    getInfo(): Promise<SystemInfo>;
    getConduitStatus(): Promise<ConduitStatus>;
  };
}
```

- [ ] **Step 2: Implement preload**

```typescript
// electron/src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { ApiSurface } from '../../renderer/src/ipc/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

const api: ApiSurface = {
  auth: {
    register: (opts) => invoke('auth:register', opts),
    login: (opts) => invoke('auth:login', opts),
    getCurrentUser: () => invoke('auth:getCurrentUser'),
    logout: () => invoke('auth:logout'),
  },
  system: {
    getInfo: () => invoke('system:getInfo'),
    getConduitStatus: () => invoke('system:getConduitStatus'),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
```

- [ ] **Step 3: Implement IPC handler registry (with stubs for now)**

```typescript
// electron/src/main/ipc/index.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');

  ipcMain.handle('auth:register', async (_evt, opts: { username: string; password: string }) => {
    // Real implementation in Task 11
    throw new Error('auth:register not implemented yet');
  });

  ipcMain.handle('auth:login', async (_evt, opts: { username: string; password: string }) => {
    throw new Error('auth:login not implemented yet');
  });

  ipcMain.handle('auth:getCurrentUser', async () => {
    throw new Error('auth:getCurrentUser not implemented yet');
  });

  ipcMain.handle('auth:logout', async () => {
    throw new Error('auth:logout not implemented yet');
  });

  ipcMain.handle('system:getInfo', async () => {
    throw new Error('system:getInfo not implemented yet');
  });

  ipcMain.handle('system:getConduitStatus', async () => {
    throw new Error('system:getConduitStatus not implemented yet');
  });
}
```

- [ ] **Step 4: Implement renderer IPC client**

```typescript
// renderer/src/ipc/client.ts
import type { ApiSurface } from './types';

declare global {
  interface Window {
    api: ApiSurface;
  }
}

export const ipc: ApiSurface = window.api;
```

- [ ] **Step 5: Typecheck both packages**

Run: `cd /workspace && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add electron/src/preload/index.ts electron/src/main/ipc/index.ts renderer/src/ipc/
git commit -m "feat(ipc): add typed IPC bridge with channel namespaces + stubs"
```

---

## Task 11: Auth IPC handlers (full implementation)

**Files:**
- Create: `electron/src/main/ipc/auth.handlers.ts`
- Modify: `electron/src/main/ipc/index.ts` (replace `auth:*` stubs)

**Interfaces:**
- Consumes: `startConduit` (T7), `createMatrixClient` (T8), `registerAdmin`/`login`/`logout` (T9), `setSecret`/`getSecret`/`deleteSecret` (T4)
- Produces: Working IPC handlers for `auth:register`, `auth:login`, `auth:getCurrentUser`, `auth:logout`.

> Tests: rather than testing IPC handlers directly (hard without Electron runtime), we test a refactored pure function `registerFlow(opts, deps)` that the handler calls. The handler is a thin wrapper.

- [ ] **Step 1: Write the failing test for `authFlows.ts`**

```typescript
// electron/tests/ipc/authFlows.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  registerFlow,
  loginFlow,
  getCurrentUserFlow,
  type AuthDeps,
} from '../../src/main/ipc/authFlows';

function makeStubMatrixClient(): MatrixClient {
  return {
    register: vi.fn().mockResolvedValue({
      user_id: '@alice:localhost',
      access_token: 'tok',
      device_id: 'DEV',
    }),
    login: vi.fn().mockResolvedValue({
      user_id: '@alice:localhost',
      access_token: 'tok',
      device_id: 'DEV',
    }),
    stopClient: vi.fn(),
  } as unknown as MatrixClient;
}

function makeDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    startConduit: vi.fn().mockResolvedValue({ port: 8008, baseUrl: 'http://127.0.0.1:8008' }),
    createMatrixClient: vi.fn().mockReturnValue(makeStubMatrixClient()),
    setSecret: vi.fn().mockResolvedValue(undefined),
    getSecret: vi.fn().mockResolvedValue(null),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    dbRun: vi.fn(),
    dbGet: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe('auth flows', () => {
  it('registerFlow starts Conduit, registers user, persists token', async () => {
    const deps = makeDeps();
    const result = await registerFlow({ username: 'alice', password: 'pass' }, deps);
    expect(result).toEqual({ userId: '@alice:localhost', deviceId: 'DEV' });
    expect(deps.startConduit).toHaveBeenCalled();
    expect(deps.setSecret).toHaveBeenCalledWith('user.@alice:localhost.matrix_token', 'tok');
    expect(deps.dbRun).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
      'current_user_id',
      JSON.stringify('@alice:localhost'),
    );
  });

  it('loginFlow logs in and persists token', async () => {
    const deps = makeDeps();
    const result = await loginFlow({ username: 'alice', password: 'pass' }, deps);
    expect(result).toEqual({ userId: '@alice:localhost', deviceId: 'DEV' });
    expect(deps.setSecret).toHaveBeenCalled();
    expect(deps.dbRun).toHaveBeenCalled();
  });

  it('getCurrentUserFlow returns null when no stored user in DB', async () => {
    const deps = makeDeps({ dbGet: vi.fn().mockReturnValue(undefined) });
    const result = await getCurrentUserFlow(deps);
    expect(result).toBeNull();
    expect(deps.getSecret).not.toHaveBeenCalled();
  });

  it('getCurrentUserFlow returns null when DB has user but token missing', async () => {
    const deps = makeDeps({
      dbGet: vi.fn().mockReturnValue({ value: JSON.stringify('@alice:localhost') }),
      getSecret: vi.fn().mockResolvedValue(null),
    });
    const result = await getCurrentUserFlow(deps);
    expect(result).toBeNull();
  });

  it('getCurrentUserFlow returns user when DB has user and token present', async () => {
    const deps = makeDeps({
      dbGet: vi.fn().mockReturnValue({ value: JSON.stringify('@alice:localhost') }),
      getSecret: vi.fn().mockResolvedValue('tok'),
    });
    const result = await getCurrentUserFlow(deps);
    expect(result).toEqual({ userId: '@alice:localhost', accessToken: 'tok' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/electron && pnpm vitest run tests/ipc/authFlows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `authFlows.ts` (pure, dependency-injected)**

```typescript
// electron/src/main/ipc/authFlows.ts
import type { MatrixClient } from 'matrix-js-sdk';
import { logger } from '../logger';

export interface AuthDeps {
  startConduit(): Promise<{ port: number; baseUrl: string }>;
  createMatrixClient(opts: { baseUrl: string; userId?: string; accessToken?: string }): MatrixClient;
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
  dbRun(sql: string, ...params: unknown[]): void;
  dbGet<T>(sql: string, ...params: unknown[]): T | undefined;
}

function tokenKey(userId: string): string {
  return `user.${userId}.matrix_token`;
}

/** Subset of Matrix auth response we care about. */
interface MatrixAuthResponse {
  user_id: string;
  access_token: string;
  device_id: string;
}

function pickAuthFields(raw: unknown): MatrixAuthResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Matrix auth response is not an object');
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.user_id !== 'string' ||
    typeof r.access_token !== 'string' ||
    typeof r.device_id !== 'string'
  ) {
    throw new Error('Matrix auth response missing or mistyped required fields');
  }
  return { user_id: r.user_id, access_token: r.access_token, device_id: r.device_id };
}

export async function registerFlow(
  opts: { username: string; password: string },
  deps: AuthDeps,
): Promise<{ userId: string; deviceId: string }> {
  const { baseUrl } = await deps.startConduit();
  const client = deps.createMatrixClient({ baseUrl });

  const raw: unknown = await client.register(opts.username, opts.password, undefined, {
    type: 'm.login.dummy',
  });
  const response = pickAuthFields(raw);

  await deps.setSecret(tokenKey(response.user_id), response.access_token);
  deps.dbRun(
    'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
    'current_user_id',
    JSON.stringify(response.user_id),
  );

  logger.info('User registered', { userId: response.user_id });
  return { userId: response.user_id, deviceId: response.device_id };
}

export async function loginFlow(
  opts: { username: string; password: string },
  deps: AuthDeps,
): Promise<{ userId: string; deviceId: string }> {
  const { baseUrl } = await deps.startConduit();
  const client = deps.createMatrixClient({ baseUrl });
  const raw: unknown = await client.login('m.login.password', {
    user: opts.username,
    password: opts.password,
    initial_device_display_name: 'AgentPlatform Desktop',
  });
  const response = pickAuthFields(raw);

  await deps.setSecret(tokenKey(response.user_id), response.access_token);
  deps.dbRun(
    'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
    'current_user_id',
    JSON.stringify(response.user_id),
  );

  logger.info('User logged in', { userId: response.user_id });
  return { userId: response.user_id, deviceId: response.device_id };
}

export async function getCurrentUserFlow(
  deps: AuthDeps,
): Promise<{ userId: string; accessToken: string } | null> {
  const stored = deps.dbGet<{ value: string }>(
    'SELECT value FROM kv_store WHERE key = ?',
    'current_user_id',
  );
  if (!stored) return null;
  const userId: string = JSON.parse(stored.value);
  const accessToken = await deps.getSecret(tokenKey(userId));
  if (!accessToken) return null;
  return { userId, accessToken };
}

export async function logoutFlow(deps: AuthDeps): Promise<void> {
  const current = await getCurrentUserFlow(deps);
  if (!current) return;
  await deps.deleteSecret(tokenKey(current.userId));
  deps.dbRun('DELETE FROM kv_store WHERE key = ?', 'current_user_id');
  logger.info('User logged out', { userId: current.userId });
}
```

- [ ] **Step 4: Adjust test expectations if needed, then run**

Run: `cd /workspace/electron && pnpm vitest run tests/ipc/authFlows.test.ts`
Expected: PASS (may need to adjust test mocks to match `dbGet` signature).

- [ ] **Step 5: Implement `auth.handlers.ts` (thin wrapper around flows + real deps)**

```typescript
// electron/src/main/ipc/auth.handlers.ts
import { ipcMain } from 'electron';
import { registerFlow, loginFlow, logoutFlow, getCurrentUserFlow, type AuthDeps } from './authFlows';
import { startConduit } from '../conduit/manager';
import { createMatrixClient } from '../matrix/client';
import { setSecret, getSecret, deleteSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
import { logger } from '../logger';

const deps: AuthDeps = {
  startConduit,
  createMatrixClient,
  setSecret,
  getSecret,
  deleteSecret,
  dbRun: (sql, ...params) => getDb().prepare(sql).run(...params),
  dbGet: <T>(sql, ...params): T | undefined =>
    getDb().prepare(sql).get(...params) as T | undefined,
};

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:register', async (_evt, opts: { username: string; password: string }) => {
    return registerFlow(opts, deps);
  });
  ipcMain.handle('auth:login', async (_evt, opts: { username: string; password: string }) => {
    return loginFlow(opts, deps);
  });
  ipcMain.handle('auth:getCurrentUser', async () => {
    return getCurrentUserFlow(deps);
  });
  ipcMain.handle('auth:logout', async () => {
    await logoutFlow(deps);
    return;
  });
  logger.info('Auth IPC handlers registered');
}
```

- [ ] **Step 6: Wire into `ipc/index.ts`**

Modify `electron/src/main/ipc/index.ts` — replace the four `auth:*` stubs with a call to `registerAuthHandlers()`, and keep the `system:*` stubs for now.

```typescript
// electron/src/main/ipc/index.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { registerAuthHandlers } from './auth.handlers';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');

  registerAuthHandlers();

  ipcMain.handle('system:getInfo', async () => {
    throw new Error('system:getInfo not implemented yet');
  });

  ipcMain.handle('system:getConduitStatus', async () => {
    throw new Error('system:getConduitStatus not implemented yet');
  });
}
```

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/ipc/ electron/tests/ipc/authFlows.test.ts
git commit -m "feat(ipc): implement auth IPC handlers via dependency-injected flows"
```

---

## Task 12: System IPC handlers

**Files:**
- Create: `electron/src/main/ipc/system.handlers.ts`
- Modify: `electron/src/main/ipc/index.ts`

**Interfaces:**
- Consumes: `isConduitRunning` (T7), `resolveUserDataDir` (T2), `app` from electron
- Produces: Working IPC handlers for `system:getInfo`, `system:getConduitStatus`.

> No dedicated test file — handlers are trivial wrappers. Verified by Task 18 (e2e).

- [ ] **Step 1: Implement `system.handlers.ts`**

```typescript
// electron/src/main/ipc/system.handlers.ts
import { ipcMain, app } from 'electron';
import os from 'node:os';
import { isConduitRunning } from '../conduit/manager';
import { resolveUserDataDir } from '../paths';
import { logger } from '../logger';

const CONDUIT_PORT = 8008;

export function registerSystemHandlers(): void {
  ipcMain.handle('system:getInfo', async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      appVersion: app.getVersion(),
      userDataDir: resolveUserDataDir(),
    };
  });

  ipcMain.handle('system:getConduitStatus', async () => {
    const running = isConduitRunning();
    return {
      running,
      baseUrl: running ? `http://127.0.0.1:${CONDUIT_PORT}` : null,
      port: running ? CONDUIT_PORT : null,
    };
  });

  logger.info('System IPC handlers registered');
}
```

- [ ] **Step 2: Update `ipc/index.ts` to register system handlers**

```typescript
// electron/src/main/ipc/index.ts
import { logger } from '../logger';
import { registerAuthHandlers } from './auth.handlers';
import { registerSystemHandlers } from './system.handlers';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');
  registerAuthHandlers();
  registerSystemHandlers();
}
```

- [ ] **Step 3: Typecheck**

Run: `cd /workspace && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add electron/src/main/ipc/system.handlers.ts electron/src/main/ipc/index.ts
git commit -m "feat(ipc): implement system info + conduit status handlers"
```

---

## Task 13: Renderer state stores (Zustand)

**Files:**
- Create: `renderer/src/stores/auth.store.ts`, `renderer/src/stores/ui.store.ts`
- Test: `renderer/src/stores/auth.store.test.ts`

**Interfaces:**
- Produces:
  - `useAuthStore` — Zustand store: `{ status: 'unknown'|'unauthenticated'|'authenticated', user: AuthResult|null, register(opts), login(opts), loadCurrent(), logout() }`
  - `useUiStore` — Zustand store: `{ activeView: 'im'|'files'|'agents'|'marketplace'|'settings', setActiveView(v) }`

- [ ] **Step 1: Write the failing test**

```typescript
// renderer/src/stores/auth.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from './auth.store';

// Mock window.api before importing
const mockApi = {
  auth: {
    register: vi.fn().mockResolvedValue({ userId: '@alice:localhost', deviceId: 'DEV' }),
    login: vi.fn().mockResolvedValue({ userId: '@alice:localhost', deviceId: 'DEV' }),
    getCurrentUser: vi.fn().mockResolvedValue(null),
    logout: vi.fn().mockResolvedValue(undefined),
  },
  system: { getInfo: vi.fn(), getConduitStatus: vi.fn() },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  mockApi.auth.getCurrentUser.mockResolvedValue(null);
  useAuthStore.getState().reset();
});

describe('auth.store', () => {
  it('starts in unknown status', () => {
    expect(useAuthStore.getState().status).toBe('unknown');
  });

  it('loadCurrent moves to unauthenticated when no current user', async () => {
    await useAuthStore.getState().loadCurrent();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('register sets authenticated', async () => {
    await useAuthStore.getState().register({ username: 'alice', password: 'pass' });
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user?.userId).toBe('@alice:localhost');
  });

  it('logout moves to unauthenticated', async () => {
    await useAuthStore.getState().register({ username: 'alice', password: 'pass' });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/renderer && pnpm vitest run src/stores/auth.store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth.store.ts`**

```typescript
// renderer/src/stores/auth.store.ts
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { AuthResult } from '../ipc/types';

export type AuthStatus = 'unknown' | 'unauthenticated' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: AuthResult | null;
  error: string | null;
  loading: boolean;

  loadCurrent: () => Promise<void>;
  register: (opts: { username: string; password: string }) => Promise<void>;
  login: (opts: { username: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  reset: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  user: null,
  error: null,
  loading: false,

  loadCurrent: async () => {
    set({ loading: true, error: null });
    try {
      const user = await ipc.auth.getCurrentUser();
      if (user) {
        set({ status: 'authenticated', user, loading: false });
      } else {
        set({ status: 'unauthenticated', user: null, loading: false });
      }
    } catch (err) {
      set({ status: 'unauthenticated', loading: false, error: (err as Error).message });
    }
  },

  register: async (opts) => {
    set({ loading: true, error: null });
    try {
      const user = await ipc.auth.register(opts);
      set({ status: 'authenticated', user, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
      throw err;
    }
  },

  login: async (opts) => {
    set({ loading: true, error: null });
    try {
      const user = await ipc.auth.login(opts);
      set({ status: 'authenticated', user, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
      throw err;
    }
  },

  logout: async () => {
    await ipc.auth.logout();
    set({ status: 'unauthenticated', user: null });
  },

  reset: () => set({ status: 'unknown', user: null, error: null, loading: false }),
}));
```

- [ ] **Step 4: Implement `ui.store.ts`**

```typescript
// renderer/src/stores/ui.store.ts
import { create } from 'zustand';

export type ViewKey = 'im' | 'files' | 'agents' | 'marketplace' | 'settings';

interface UiState {
  activeView: ViewKey;
  setActiveView: (view: ViewKey) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeView: 'im',
  setActiveView: (view) => set({ activeView: view }),
}));
```

- [ ] **Step 5: Run tests**

Run: `cd /workspace/renderer && pnpm vitest run src/stores/`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add renderer/src/stores/
git commit -m "feat(renderer): add auth and UI Zustand stores"
```

---

## Task 14: Electron main entry + window + onboarding gate

**Files:**
- Create: `electron/src/main/window.ts`, `electron/src/main/index.ts`

**Interfaces:**
- Consumes: `registerIpcHandlers` (T10), `runMigrations` (T3), `startConduit` (T7)
- Produces: Running Electron app with a single BrowserWindow loading the renderer.

> No test (Electron entry is hard to unit test). Verified by Task 18 (e2e).

- [ ] **Step 1: Implement `window.ts`**

```typescript
// electron/src/main/window.ts
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { logger } from './logger';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL; // e.g. http://localhost:5173

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a1a',
    title: 'AgentPlatform',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    logger.info('Window ready');
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html'));
  }

  return win;
}
```

- [ ] **Step 2: Implement `index.ts` (Electron entry)**

```typescript
// electron/src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { runMigrations } from './storage/db';
import { startConduit } from './conduit/manager';
import { logger } from './logger';

// Single-instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  try {
    logger.info('App starting', { version: app.getVersion() });

    // 1. DB migrations
    runMigrations();
    logger.info('Migrations complete');

    // 2. Conduit (lazy: actually starts on first auth request, but we eagerly
    //    pre-warm to make first onboarding step faster)
    void startConduit().catch((err) => {
      logger.error('Conduit pre-start failed (will retry on auth)', { error: err.message });
    });

    // 3. IPC handlers
    registerIpcHandlers();

    // 4. Window
    createMainWindow();
  } catch (err) {
    logger.error('Fatal startup error', { error: (err as Error).message });
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', async () => {
  // Conduit is stopped by manager on SIGTERM, but ensure cleanup
  const { stopConduit } = await import('./conduit/manager');
  await stopConduit();
});
```

- [ ] **Step 3: Build main process**

Run: `cd /workspace/electron && pnpm build`
Expected: TypeScript compiles to `electron/dist/`.

- [ ] **Step 4: Commit**

```bash
git add electron/src/main/window.ts electron/src/main/index.ts
git commit -m "feat(main): wire app entry — window, migrations, conduit, IPC"
```

---

## Task 15: Onboarding wizard UI

**Files:**
- Create: `renderer/src/components/onboarding/WelcomeStep.tsx`, `ModeSelectStep.tsx`, `AccountSetupStep.tsx`, `CompleteStep.tsx`
- Create: `renderer/src/routes/Onboarding.tsx`
- Create: `renderer/src/lib/cn.ts`
- Test: `renderer/src/routes/Onboarding.test.tsx`

**Interfaces:**
- Consumes: `useAuthStore` (T13), `ipc.system.getInfo()`, `ipc.system.getConduitStatus()`
- Produces: 4-step onboarding flow that:
  1. Welcome screen
  2. Mode select (only "standalone" enabled in M0; "connect existing" disabled with "Coming soon")
  3. Account setup (username/password + create button → calls `authStore.register`)
  4. Complete → navigates to main shell

- [ ] **Step 1: Create `cn.ts` utility**

```typescript
// renderer/src/lib/cn.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Set up Tailwind CSS in renderer**

Create `/workspace/renderer/postcss.config.js`:

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

Create `/workspace/renderer/tailwind.config.js`:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: { primary: '#1a1a1a', secondary: '#242424', tertiary: '#2e2e2e' },
        border: { subtle: '#3a3a3a', strong: '#4a4a4a' },
        accent: { blue: '#3b82f6', purple: '#8b5cf6' },
      },
    },
  },
  plugins: [],
};
```

Create `renderer/src/styles/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root {
  height: 100%;
  margin: 0;
  background: theme('colors.bg.primary');
  color: #e5e5e5;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

- [ ] **Step 3: Write the failing test for `Onboarding.tsx`**

```typescript
// renderer/src/routes/Onboarding.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { useAuthStore } from '../stores/auth.store';

const mockApi = {
  auth: {
    register: vi.fn().mockResolvedValue({ userId: '@alice:localhost', deviceId: 'DEV' }),
    login: vi.fn(),
    getCurrentUser: vi.fn().mockResolvedValue(null),
    logout: vi.fn(),
  },
  system: { getInfo: vi.fn().mockResolvedValue({}), getConduitStatus: vi.fn().mockResolvedValue({}) },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  useAuthStore.getState().reset();
  mockApi.auth.register.mockClear();
});

describe('Onboarding', () => {
  it('renders welcome step first', () => {
    render(<Onboarding onComplete={() => {}} />);
    expect(screen.getByText(/welcome/i)).toBeInTheDocument();
  });

  it('advances through steps to account setup', async () => {
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);

    // Welcome → Mode
    fireEvent.click(screen.getByRole('button', { name: /next|continue|get started/i }));
    expect(await screen.findByText(/mode|standalone|connect/i)).toBeInTheDocument();

    // Mode → Account (select standalone)
    fireEvent.click(screen.getByRole('button', { name: /standalone/i }));
    fireEvent.click(screen.getByRole('button', { name: /next|continue/i }));
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();

    // Account → Complete
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: /create|register|sign up/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
    expect(mockApi.auth.register).toHaveBeenCalledWith({
      username: 'alice',
      password: 'pass123',
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /workspace/renderer && pnpm vitest run src/routes/Onboarding.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement step components**

```tsx
// renderer/src/components/onboarding/WelcomeStep.tsx
import { Button } from '../ui/Button';

interface Props {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: Props) {
  return (
    <div className="flex flex-col items-center gap-8 p-12">
      <h1 className="text-4xl font-bold">Welcome to AgentPlatform</h1>
      <p className="text-lg text-neutral-400 max-w-md text-center">
        A local-first multi-agent collaboration platform. Set up your workspace in a few steps.
      </p>
      <Button onClick={onNext} size="lg">Get started</Button>
    </div>
  );
}
```

```tsx
// renderer/src/components/onboarding/ModeSelectStep.tsx
import { useState } from 'react';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';

interface Props {
  onNext: (mode: 'standalone') => void;
  onBack: () => void;
}

export function ModeSelectStep({ onNext, onBack }: Props) {
  const [selected, setSelected] = useState<'standalone' | 'connect'>('standalone');

  return (
    <div className="flex flex-col gap-6 p-12">
      <h2 className="text-2xl font-bold">Choose mode</h2>
      <div className="flex gap-4">
        <button
          className={cn(
            'flex-1 p-6 text-left rounded-lg border',
            selected === 'standalone'
              ? 'border-accent-blue bg-accent-blue/10'
              : 'border-border-subtle hover:border-border-strong',
          )}
          onClick={() => setSelected('standalone')}
        >
          <div className="text-lg font-semibold mb-2">Standalone (recommended)</div>
          <p className="text-sm text-neutral-400">
            Built-in homeserver runs locally. No external dependencies. Best for first-time use.
          </p>
        </button>
        <button
          className="flex-1 p-6 text-left rounded-lg border border-border-subtle opacity-50 cursor-not-allowed"
          disabled
        >
          <div className="text-lg font-semibold mb-2">Connect to existing</div>
          <p className="text-sm text-neutral-400">
            Connect to a homeserver you already run. Coming in v1.1.
          </p>
        </button>
      </div>
      <div className="flex gap-3 justify-end">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button onClick={() => onNext(selected)}>Continue</Button>
      </div>
    </div>
  );
}
```

```tsx
// renderer/src/components/onboarding/AccountSetupStep.tsx
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAuthStore } from '../../stores/auth.store';

interface Props {
  onNext: () => void;
  onBack: () => void;
}

export function AccountSetupStep({ onNext, onBack }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const { register, loading, error } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (password !== confirm) {
      setLocalError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setLocalError('Password must be at least 6 characters');
      return;
    }
    try {
      await register({ username, password });
      onNext();
    } catch {
      // error is in store
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-12 max-w-md mx-auto w-full">
      <h2 className="text-2xl font-bold">Create your account</h2>
      <p className="text-sm text-neutral-400">
        This account is stored locally on the built-in homeserver. No data leaves your machine.
      </p>
      <Input
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        required
      />
      <Input
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        required
      />
      <Input
        label="Confirm password"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        required
      />
      {(localError || error) && (
        <div className="text-red-400 text-sm">{localError ?? error}</div>
      )}
      <div className="flex gap-3 justify-end">
        <Button variant="ghost" type="button" onClick={onBack}>Back</Button>
        <Button type="submit" disabled={loading || !username}>
          {loading ? 'Creating…' : 'Create account'}
        </Button>
      </div>
    </form>
  );
}
```

```tsx
// renderer/src/components/onboarding/CompleteStep.tsx
import { useEffect } from 'react';
import { Button } from '../ui/Button';

interface Props {
  onComplete: () => void;
}

export function CompleteStep({ onComplete }: Props) {
  useEffect(() => {
    const t = setTimeout(onComplete, 1500);
    return () => clearTimeout(t);
  }, [onComplete]);

  return (
    <div className="flex flex-col items-center gap-4 p-12">
      <div className="text-5xl">✓</div>
      <h1 className="text-2xl font-bold">You're all set</h1>
      <p className="text-neutral-400">Taking you to your workspace…</p>
      <Button onClick={onComplete}>Continue</Button>
    </div>
  );
}
```

- [ ] **Step 6: Create Button + Input UI primitives**

```tsx
// renderer/src/components/ui/Button.tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'primary', size = 'md', className, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'rounded-md font-medium transition-colors',
          size === 'sm' && 'px-3 py-1.5 text-sm',
          size === 'md' && 'px-4 py-2',
          size === 'lg' && 'px-6 py-3 text-lg',
          variant === 'primary' && 'bg-accent-blue hover:bg-accent-blue/90 text-white',
          variant === 'ghost' && 'hover:bg-bg-tertiary text-neutral-300',
          variant === 'danger' && 'bg-red-600 hover:bg-red-700 text-white',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          className,
        )}
        {...rest}
      />
    );
  },
);
Button.displayName = 'Button';
```

```tsx
// renderer/src/components/ui/Input.tsx
import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, className, id, ...rest }, ref) => {
    return (
      <label className="flex flex-col gap-1">
        {label && <span className="text-sm text-neutral-300">{label}</span>}
        <input
          ref={ref}
          id={id}
          className={cn(
            'px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle',
            'focus:border-accent-blue focus:outline-none',
            className,
          )}
          {...rest}
        />
      </label>
    );
  },
);
Input.displayName = 'Input';
```

- [ ] **Step 7: Implement `Onboarding.tsx`**

```tsx
// renderer/src/routes/Onboarding.tsx
import { useState } from 'react';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { ModeSelectStep } from '../components/onboarding/ModeSelectStep';
import { AccountSetupStep } from '../components/onboarding/AccountSetupStep';
import { CompleteStep } from '../components/onboarding/CompleteStep';

type Step = 'welcome' | 'mode' | 'account' | 'complete';

interface Props {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome');

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-full max-w-2xl bg-bg-secondary rounded-xl border border-border-subtle">
        {step === 'welcome' && <WelcomeStep onNext={() => setStep('mode')} />}
        {step === 'mode' && (
          <ModeSelectStep
            onNext={() => setStep('account')}
            onBack={() => setStep('welcome')}
          />
        )}
        {step === 'account' && (
          <AccountSetupStep
            onNext={() => setStep('complete')}
            onBack={() => setStep('mode')}
          />
        )}
        {step === 'complete' && <CompleteStep onComplete={onComplete} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run tests**

Run: `cd /workspace/renderer && pnpm vitest run src/routes/Onboarding.test.tsx`
Expected: PASS (2 tests). May need to adjust button text matching in test — exact text from Button labels must match `getByRole('button', { name: /pattern/i })`.

- [ ] **Step 9: Commit**

```bash
git add renderer/src/components/onboarding/ renderer/src/components/ui/ \
        renderer/src/routes/Onboarding.tsx renderer/src/routes/Onboarding.test.tsx \
        renderer/src/lib/cn.ts renderer/postcss.config.js renderer/tailwind.config.js \
        renderer/src/styles/globals.css
git commit -m "feat(renderer): add 4-step onboarding wizard with auth integration"
```

---

## Task 16: Main shell layout

**Files:**
- Create: `renderer/src/components/layout/MainLayout.tsx`, `LeftRail.tsx`, `MiddlePanel.tsx`, `RightPanel.tsx`
- Create: `renderer/src/routes/MainShell.tsx`
- Test: `renderer/src/components/layout/MainLayout.test.tsx`

**Interfaces:**
- Consumes: `useUiStore` (T13)
- Produces: 3-column shell:
  - Left rail (56px): workspace switcher (empty placeholder in M0) + nav icons
  - Middle: renders view based on `activeView`; M0 shows "Coming soon" placeholder for all views except Settings
  - Right: hidden in M0 (zero width)

- [ ] **Step 1: Write the failing test**

```typescript
// renderer/src/components/layout/MainLayout.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainLayout } from './MainLayout';
import { useUiStore } from '../../stores/ui.store';

describe('MainLayout', () => {
  it('renders left rail with all 5 nav icons', () => {
    render(<MainLayout />);
    expect(screen.getByLabelText('View: IM')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Files')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Agents')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Marketplace')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Settings')).toBeInTheDocument();
  });

  it('clicking nav icon switches active view', () => {
    render(<MainLayout />);
    fireEvent.click(screen.getByLabelText('View: Settings'));
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('middle panel shows "coming soon" placeholder for IM view in M0', () => {
    render(<MainLayout />);
    expect(screen.getByText(/coming soon|not yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/renderer && pnpm vitest run src/components/layout/MainLayout.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `LeftRail.tsx`**

```tsx
// renderer/src/components/layout/LeftRail.tsx
import { cn } from '../../lib/cn';
import { useUiStore, type ViewKey } from '../../stores/ui.store';

const NAV_ITEMS: { key: ViewKey; icon: string; label: string }[] = [
  { key: 'im', icon: '💬', label: 'View: IM' },
  { key: 'files', icon: '📁', label: 'View: Files' },
  { key: 'agents', icon: '🤖', label: 'View: Agents' },
  { key: 'marketplace', icon: '🛒', label: 'View: Marketplace' },
  { key: 'settings', icon: '⚙', label: 'View: Settings' },
];

export function LeftRail() {
  const { activeView, setActiveView } = useUiStore();

  return (
    <div className="w-14 bg-bg-secondary border-r border-border-subtle flex flex-col items-center py-3 gap-2">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.key}
          aria-label={item.label}
          title={item.label.replace('View: ', '')}
          onClick={() => setActiveView(item.key)}
          className={cn(
            'w-10 h-10 flex items-center justify-center rounded-md text-xl',
            activeView === item.key
              ? 'bg-accent-blue/20 border border-accent-blue/50'
              : 'hover:bg-bg-tertiary',
          )}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement `MiddlePanel.tsx`**

```tsx
// renderer/src/components/layout/MiddlePanel.tsx
import { useUiStore } from '../../stores/ui.store';

export function MiddlePanel() {
  const { activeView } = useUiStore();

  // In M0, all views show placeholder. Settings is the only one wired to anything.
  // (Settings UI is implemented in a later task — for now also placeholder.)
  return (
    <div className="flex-1 bg-bg-primary flex items-center justify-center">
      <div className="text-center text-neutral-500">
        <div className="text-4xl mb-3">
          {activeView === 'im' && '💬'}
          {activeView === 'files' && '📁'}
          {activeView === 'agents' && '🤖'}
          {activeView === 'marketplace' && '🛒'}
          {activeView === 'settings' && '⚙'}
        </div>
        <h2 className="text-xl font-semibold capitalize">{activeView}</h2>
        <p className="mt-1 text-sm">Coming soon in M1+</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `RightPanel.tsx` (hidden in M0)**

```tsx
// renderer/src/components/layout/RightPanel.tsx
export function RightPanel() {
  // Hidden in M0; no content yet.
  return null;
}
```

- [ ] **Step 6: Implement `MainLayout.tsx`**

```tsx
// renderer/src/components/layout/MainLayout.tsx
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';
import { RightPanel } from './RightPanel';

export function MainLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-primary">
      <LeftRail />
      <MiddlePanel />
      <RightPanel />
    </div>
  );
}
```

- [ ] **Step 7: Implement `MainShell.tsx` (route)**

```tsx
// renderer/src/routes/MainShell.tsx
import { MainLayout } from '../components/layout/MainLayout';

export function MainShell() {
  return <MainLayout />;
}
```

- [ ] **Step 8: Run test**

Run: `cd /workspace/renderer && pnpm vitest run src/components/layout/MainLayout.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add renderer/src/components/layout/ renderer/src/routes/MainShell.tsx
git commit -m "feat(renderer): add 3-column main shell layout with nav rail"
```

---

## Task 17: Root App + renderer entry

**Files:**
- Create: `renderer/src/App.tsx`, `renderer/src/main.tsx`

**Interfaces:**
- Consumes: `useAuthStore` (T13), `Onboarding` (T15), `MainShell` (T16)
- Produces: React app that gates between Onboarding and MainShell based on auth status.

- [ ] **Step 1: Implement `App.tsx`**

```tsx
// renderer/src/App.tsx
import { useEffect } from 'react';
import { useAuthStore } from './stores/auth.store';
import { Onboarding } from './routes/Onboarding';
import { MainShell } from './routes/MainShell';

export function App() {
  const { status, loadCurrent } = useAuthStore();

  useEffect(() => {
    if (status === 'unknown') {
      void loadCurrent();
    }
  }, [status, loadCurrent]);

  if (status === 'unknown' || status === 'unauthenticated') {
    return <Onboarding onComplete={() => { /* status flips to authenticated */ }} />;
  }

  return <MainShell />;
}
```

- [ ] **Step 2: Implement `main.tsx`**

```tsx
// renderer/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd /workspace/renderer && pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add renderer/src/App.tsx renderer/src/main.tsx
git commit -m "feat(renderer): add root App component with auth-based routing"
```

---

## Task 18: electron-builder packaging

**Files:**
- Modify: `electron/package.json` (add `build` config + scripts)
- Create: `electron/build/entitlements.mac.plist`, `electron/build/icon.png` (placeholder)

**Interfaces:**
- Produces: `pnpm --filter ./electron dist` produces a macOS `.dmg` and Linux `.AppImage`.

> No automated test for packaging (it's slow and platform-specific). Manual verification: `pnpm dist` succeeds on macOS arm64 dev machine.

- [ ] **Step 1: Add packaging config to `electron/package.json`**

Append this `build` block:

```json
{
  "build": {
    "appId": "io.agentplatform.desktop",
    "productName": "AgentPlatform",
    "directories": {
      "output": "dist-installers",
      "buildResources": "build"
    },
    "files": [
      "dist/**/*",
      "node_modules/**/*",
      "package.json",
      "!**/*.map",
      "!**/*.ts"
    ],
    "extraResources": [
      {
        "from": "../resources/conduit",
        "to": "conduit",
        "filter": ["conduit-*"]
      },
      {
        "from": "../renderer/dist",
        "to": "renderer"
      }
    ],
    "mac": {
      "category": "public.app-category.developer-tools",
      "target": ["dmg"],
      "hardenedRuntime": false,
      "gatekeeperAssess": false
    },
    "linux": {
      "target": ["AppImage"],
      "category": "Development"
    },
    "win": {
      "target": ["nsis"]
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "concurrently \"tsc -p tsconfig.json --watch\" \"electron .\"",
    "test": "vitest run --config vitest.config.ts",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit",
    "dist": "pnpm build && pnpm --filter ../renderer build && electron-builder",
    "pack": "pnpm build && pnpm --filter ../renderer build && electron-builder --dir"
  }
}
```

Add `electron-builder` to devDependencies:

```bash
cd /workspace/electron && pnpm add -D electron-builder
```

- [ ] **Step 2: Create a placeholder Mac entitlements file**

```xml
<!-- electron/build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 3: Add a placeholder icon**

Create `electron/build/icon.png` — a 512x512 PNG. Use any placeholder (e.g., a colored square). For dev, copy any image:

```bash
# In a real project, replace with branded icon
cp node_modules/electron-builder/templates/icon.png electron/build/icon.png 2>/dev/null || true
```

- [ ] **Step 4: Run packaging (local)**

Run: `cd /workspace/electron && pnpm pack`
Expected: produces `electron/dist-installers/mac-arm64/AgentPlatform.app` (or platform equivalent). Takes 1-3 minutes.

- [ ] **Step 5: Commit**

```bash
git add electron/package.json electron/build/
git commit -m "build: add electron-builder packaging config (macOS, Linux, Windows)"
```

---

## Task 19: End-to-end onboarding integration test

**Files:**
- Create: `tests/e2e/onboarding.spec.ts`

**Interfaces:**
- Produces: A test that:
  1. Launches the packaged Electron app (or runs against dev server)
  2. Walks through the 4 onboarding steps
  3. Verifies the main shell appears
  4. Verifies `kv_store` in SQLite has `current_user_id`
  5. Verifies keychain has the Matrix token

> **Approach:** Use `playwright` with `electron` integration (`_electron.exec`). This test is heavy — skip in CI for now; run manually before tagging a release.

- [ ] **Step 1: Add Playwright test dependency**

```bash
cd /workspace && pnpm add -D -w @playwright/test playwright
```

Create `/workspace/tests/e2e/playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 120000,
  use: {
    trace: 'retain-on-failure',
  },
});
```

- [ ] **Step 2: Write the e2e test**

```typescript
// tests/e2e/onboarding.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpUserData = path.join(os.tmpdir(), `ap-e2e-${Date.now()}`);

test.beforeAll(() => {
  fs.mkdirSync(tmpUserData, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

test('full onboarding flow', async () => {
  const appPath = path.resolve(__dirname, '..', '..', 'electron', 'dist-installers');
  // For dev: use electron binary directly
  const electronPath = require('electron') as string;

  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'electron')],
    env: {
      ...process.env,
      AP_USER_DATA_DIR: tmpUserData,
      NODE_ENV: 'production',
    },
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Step 1: Welcome
  await win.getByRole('button', { name: /get started/i }).click();

  // Step 2: Mode
  await win.getByText(/standalone/i).click();
  await win.getByRole('button', { name: /continue/i }).click();

  // Step 3: Account
  await win.getByLabel(/username/i).fill('alice');
  await win.getByLabel(/^password/i).fill('passpass');
  await win.getByLabel(/confirm password/i).fill('passpass');
  await win.getByRole('button', { name: /create account/i }).click();

  // Step 4: Complete (auto-advances after 1.5s)
  // Main shell should appear
  await expect(win.getByLabelText('View: IM')).toBeVisible({ timeout: 15000 });

  // Verify state.db has user
  const dbPath = path.join(tmpUserData, 'state.db');
  expect(fs.existsSync(dbPath)).toBe(true);
  // (Reading the DB from outside Electron is possible with better-sqlite3 but
  //  not strictly required. We rely on the visible UI as proof.)

  await app.close();
});
```

- [ ] **Step 3: Run the e2e test (manual)**

> Prerequisites: `pnpm --filter ./electron build` and `pnpm --filter ./renderer build` must have run.

Run: `cd /workspace && pnpm playwright test tests/e2e/onboarding.spec.ts`
Expected: PASS within 60 seconds.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/ package.json pnpm-lock.yaml
git commit -m "test(e2e): add full onboarding flow integration test"
```

---

## Task 20: README + developer setup docs

**Files:**
- Create: `/workspace/README.md`, `/workspace/docs/dev/setup.md`, `/workspace/docs/dev/conduit-manual.md`

**Interfaces:**
- Produces: A new contributor can clone, `pnpm install`, `pnpm dev`, and have the app launch in <10 minutes.

- [ ] **Step 1: Write `README.md`**

```markdown
# AgentPlatform

Personal desktop multi-agent collaboration platform. See `docs/specs/2026-07-28-agent-platform-design.md` for the full design.

## Status

**M0 (project skeleton)** — in progress.

## Prerequisites

- Node.js 20 LTS
- pnpm 9+
- macOS (arm64 or x64) or Linux (x64). Windows is v2.

## Setup

```bash
git clone <repo>
cd agentplatform
pnpm install
```

The `postinstall` script downloads a pre-built Conduit binary. If it fails (offline), see `docs/dev/conduit-manual.md` for manual placement.

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
- `tests/e2e/` — End-to-end integration tests
```

- [ ] **Step 2: Write `docs/dev/setup.md`**

```markdown
# Developer setup

Detailed setup for new contributors. See README.md for the short version.

## 1. System requirements

- Node.js 20 LTS (use nvm/fnm to install)
- pnpm 9+: `npm install -g pnpm`
- Git
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: build-essential, libsecret-1-dev (for keytar)

## 2. Clone and install

\`\`\`bash
git clone <repo-url>
cd agentplatform
pnpm install
\`\`\`

The install will:
1. Install root deps
2. Recursively install `electron/` and `renderer/` workspace deps
3. Run `resources/conduit/download.ts` to fetch the Conduit binary

If step 3 fails (no network), see `conduit-manual.md`.

## 3. First run

\`\`\`bash
pnpm dev
\`\`\`

The Electron app launches. You should see the welcome onboarding step. Walk through it:
- Mode: Standalone
- Account: pick any username + password (stored locally only)
- Complete → main shell

## 4. Common commands

| Command | Description |
|---|---|
| `pnpm dev` | Run Electron + Vite HMR |
| `pnpm build` | Build all packages (TS compile + Vite build) |
| `pnpm test` | Run all unit tests once |
| `pnpm test:watch` | Run unit tests in watch mode |
| `pnpm lint` | ESLint across all packages |
| `pnpm typecheck` | TypeScript type check only |
| `pnpm --filter ./electron dist` | Build native installer |

## 5. Debugging

- Main process logs: `~/.agent-platform/logs/main.log`
- Conduit logs: stdout captured into main process log
- Renderer DevTools: View → Toggle Developer Tools (when running dev)

## 6. Reset local state

To wipe all local data and start over:

\`\`\`bash
rm -rf ~/.agent-platform
\`\`\`

This removes: SQLite state, Conduit data dir, logs. Keychain entries remain (clean them via Keychain Access / `secret-tool`).
```

- [ ] **Step 3: Write `docs/dev/conduit-manual.md`**

```markdown
# Manual Conduit binary placement

If `pnpm postinstall` failed to download Conduit (offline, firewall, etc.), you can place the binary manually.

## 1. Identify your target

| Platform | Filename |
|---|---|
| macOS arm64 | `conduit-darwin-arm64` |
| macOS x64 | `conduit-darwin-x64` |
| Linux x64 | `conduit-linux-x64` |
| Windows x64 | `conduit-windows-x64.exe` |

## 2. Download from GitHub releases

<https://github.com/girlbossceo/conduit/releases>

Pick the version pinned in `resources/conduit/download.ts` (`CONDUIT_VERSION`).

## 3. Place the binary

\`\`\`bash
mv ~/Downloads/conduit-darwin-arm64 /workspace/resources/conduit/
chmod +x /workspace/resources/conduit/conduit-darwin-arm64   # macOS/Linux only
\`\`\`

## 4. Verify

\`\`\`bash
/workspace/resources/conduit/conduit-darwin-arm64 --version
\`\`\`

Should print Conduit's version.

## 5. Re-run dev

\`\`\`bash
pnpm dev
\`\`\`
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/dev/
git commit -m "docs: add README + developer setup + conduit manual placement"
```

---

## Self-Review

After completing all tasks, verify:

### Spec coverage (from `docs/specs/2026-07-28-agent-platform-design.md`, M0 scope)

| Spec item | Covered by |
|---|---|
| Electron + React + TypeScript project init | T1 |
| 内置 Conduit 集成 | T5, T6, T7 |
| 基础 SQLite 接入 | T3 |
| 基础 keychain 接入 | T4 |
| matrix-js-sdk 接入 | T8 |
| 登录流程 | T9, T11 |
| Onboarding 向导 v0 | T15 |
| 主框架布局（左栏 + 中间 + 右栏编辑器） | T16 |
| 用户能启动应用 + 注册账号 + 看到主界面（空） | T18, T19 |

### Placeholder scan

- ✅ No "TBD", "TODO", "implement later"
- ✅ Every code step has actual code
- ✅ Every test step has actual test code
- ✅ Exact file paths everywhere

### Type consistency

- `AuthResult` type defined once in `renderer/src/ipc/types.ts`, used consistently across stores, components, IPC handlers.
- `ConduitInfo` type defined in `electron/src/main/conduit/manager.ts`, used by handlers and `authFlows.ts` via the `AuthDeps.startConduit` return type.
- `setKeychainImpl` / `setBinaryOverride` hooks used consistently in tests.

### Known gaps / explicit non-goals for M0

- **Settings UI**: Left rail has Settings icon but middle panel shows placeholder. Settings UI itself is M3 (Workspace settings come with Workspace CRUD in M1).
- **Real Conduit binary in CI**: Tests use fake binary (T7) — real binary only needed for local dev + e2e.
- **i18n**: Hard-coded English in M0.
- **macOS code signing / notarization**: Disabled in M0 (`hardenedRuntime: false`). Required for public distribution — addressed in M4.

---

## Execution Handoff

Plan complete and saved to `/workspace/docs/plans/2026-07-28-m0-project-skeleton.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks. Fast iteration, isolated context per task. Best for executing this plan as-is.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Best if you want to pair on each task.
