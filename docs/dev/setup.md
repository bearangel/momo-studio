# Developer setup

Detailed setup for new contributors. See `README.md` for the short version.

## 1. System requirements

- **Node.js 20 LTS** (use nvm/fnm to install). Do **not** use Node 26 or newer: the native build step for `better-sqlite3` fails on Node 26+ and `pnpm install` will abort.
- pnpm 9+: `npm install -g pnpm`
- Git
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: build-essential, libsecret-1-dev (for keytar)

### Why Node 20, not 26

`better-sqlite3` ships prebuilt binaries for the active LTS line (18, 20, 22). Node 26 falls outside that range and triggers a source compile against headers that haven't shipped yet, which fails. If you accidentally upgrade, downgrade with `nvm install 20 && nvm use 20` and rerun `pnpm install`.

## 2. Clone and install

```bash
git clone <repo-url>
cd momo-studio
pnpm install
```

The install will:
1. Install root deps.
2. Recursively install `electron/` and `renderer/` workspace deps.
3. Run `resources/conduit/download.ts` to fetch the Conduit binary.

If step 3 fails (no network), see `conduit-manual.md`.

### Heads-up about `matrix-js-sdk`

We pin `^31.0.0`, not `^34`. Version 34 is ESM-only, and our Electron main process is CommonJS, so `import` of `matrix-js-sdk` throws `ERR_REQUIRE_ESM`. If you see that error during `pnpm install` or app boot, your lockfile got out of sync: run `pnpm install --frozen-lockfile` to restore the pinned version.

## 3. First run

```bash
pnpm dev
```

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
| `pnpm test:e2e` | Playwright integration tests against a built app |

## 5. Debugging

- Main process logs: `~/.agent-platform/logs/main.log`
- Conduit logs: stdout captured into main process log
- Renderer DevTools: View → Toggle Developer Tools (when running dev)

## 6. Reset local state

To wipe all local data and start over:

```bash
rm -rf ~/.agent-platform
```

This removes: SQLite state, Conduit data dir, logs. Keychain entries remain (clean them via Keychain Access / `secret-tool`).