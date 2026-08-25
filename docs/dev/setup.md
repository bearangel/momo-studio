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

2.0.0 起无外部服务依赖——Matrix/Tuwunel 已整体移除（P1），会话内核为进程内
SQLite + 事件分发，本地零后台进程。

## 3. First run

```bash
pnpm dev
```

`pnpm dev`（`electron/scripts/dev.mjs`）会依次拉起三个进程：
1. **renderer vite dev server**（5173，HMR——renderer 源码改动即时生效，无需重建 `renderer/dist`）
2. **electron 主进程 tsc watch**（首跑全量编译，改动增量重编）
3. 两者就绪后启动 **Electron**，注入 `VITE_DEV_SERVER_URL` 走 dev server 加载页面

注意：dev 模式页面来自 vite dev server（不是 `renderer/dist` 静态产物）——
「改了 renderer 没生效」的 stale 构建问题自此根除。打包/发布仍走 `pnpm build`。

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

- Main process logs: `~/.momo-studio/logs/main.log`
- Conduit logs: stdout captured into main process log
- Renderer DevTools: View → Toggle Developer Tools (when running dev)

## 6. Reset local state

To wipe all local data and start over:

```bash
rm -rf ~/.momo-studio
```

This removes: SQLite state, Conduit data dir, logs. Keychain entries remain (clean them via Keychain Access / `secret-tool`).