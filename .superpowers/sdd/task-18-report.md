# Task 18 Report — task-status 统一状态映射模块

## 实现内容

按 brief 在 `renderer/src/lib/` 下新建两个文件：

- `renderer/src/lib/task-status.ts` —— 任务状态统一映射模块。`TaskStatusKey` 类型覆盖规范 §3.6 八种状态；`STATUS_LABEL` 提供中文标签；`STATUS_TONE` 记录语义 tone；`taskStatusStyle(status)` 返回 `{ label, tone, className }`。`className` 由布局类（`inline-flex h-5 items-center rounded px-2 text-xs font-medium`）+ `BADGE_TONE_CLASSES[tone]` 拼接，**禁止另造调色板**。
- `renderer/src/lib/task-status.test.ts` —— 三组断言：八状态全覆盖 + 中文标签唯一；tone 映射逐字段断言；className 与 Badge tone 类同源（`bg-status-error-tint` / `bg-status-success-tint` 抽样校验）。

代码 verbatim 采用 brief 提供版本，仅注释中文化。

## TDD Evidence

### RED（实施前）
```
RUN  v1.6.1 /workspace/renderer
 ❯ src/lib/task-status.test.ts  (0 test)

 FAIL  src/lib/task-status.test.ts [ src/lib/task-status.test.ts ]
Error: Failed to resolve import "./task-status" from "src/lib/task-status.test.ts". Does the file exist?

Test Files  1 failed (1)
     Tests  no tests
```
模块不存在 → import 解析失败 → 0 tests collected。

### GREEN（实施后）
```
RUN  v1.6.1 /workspace/renderer
 ✓ src/lib/task-status.test.ts  (3 tests) 1ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

## 套件 + Typecheck 结果

- **任务测试**：`src/lib/task-status.test.ts` 3/3 PASS（1ms）。
- **Renderer 全套**：`Test Files  90 passed (90)` / `Tests  774 passed (774)`（17.20s）——零回归。
- **Renderer typecheck**：`npx tsc --noEmit` 退出码 0。

## 改动文件

```
renderer/src/lib/task-status.ts       | new  | 39 lines
renderer/src/lib/task-status.test.ts  | new  | 50 lines
```

## Commit

`859c694` — `feat(renderer): task-status 统一状态映射模块——四份调色板收敛为单源`

## 自检

| 检查项 | 结果 |
|---|---|
| 八状态全覆盖（draft/pending/assigned/in_progress/paused/completed/cancelled/failed） | ✅ `TaskStatusKey` 联合类型 + `STATUS_LABEL` / `STATUS_TONE` 各 8 项 |
| tone 映射符合规范 §3.6（neutral/warning/accent/success/violet/neutral/neutral/error） | ✅ 三组断言逐字段校验通过 |
| className 由 `BADGE_TONE_CLASSES[tone]` 同源组合（不另造调色板） | ✅ 测试断言 `bg-status-error-tint` / `bg-status-success-tint` 命中 |
| 中文标签唯一（草稿/待分配/已分配/进行中/已暂停/已完成/已取消/失败） | ✅ `Set` size === 8 |
| 注释中文化 | ✅ 头部说明 + spec §3.6 引用 |
| 导入路径 `'../components/ui/Badge'`（type + value 同源） | ✅ 与 brief 一致；vitest + vite 解析通过 |

## 关注点

无。P2 迁移（TaskChip/TaskCard/DispatchChip/ToolCallChip 四处）不在本任务范围，P0 仅建模块不消费，按 brief 严格执行。

## What changed

| File | Change |
|------|--------|
| `electron/package.json` | Added `build` config block, `dist` + `pack` scripts, and `electron-builder ^26.15.3` devDep |
| `electron/build/entitlements.mac.plist` | Created — minimal Mac entitlements (`com.apple.security.cs.allow-unsigned-executable-memory`) |
| `electron/build/icon.png` | Created — 512×512 RGBA placeholder (solid `#2563eb`) |
| `.gitignore` | Added `dist-installers/` to keep 290 MB of binary artifacts out of git |
| `pnpm-lock.yaml` | Updated for new `electron-builder` dependency |

## Verification

Ran `pnpm --filter ./electron run pack` on this Linux arm64 environment.

Result: **success** — produced `electron/dist-installers/linux-arm64-unpacked/` (~290 MB).

- `app.asar` packaged with `dist/`, `node_modules/`, `package.json`; `.ts` and `.map` correctly excluded by the `files` filter.
- `resources/renderer/` populated via `extraResources` (the renderer dist was built and copied into the unpacked app).
- `resources/conduit/` **absent** — expected. The conduit binary has no `linux-arm64` build (the `postinstall` step bails on this platform), so the `conduit-*` glob matched nothing and `electron-builder` skipped that extraResource. The config is correct; on a target platform with the binary present it would be packaged.
- Native modules (`better-sqlite3`, `keytar`) rebuilt for `arm64` via `@electron/rebuild`.
- `mac`/`linux`/`win` targets all configured. On Linux only `linux.AppImage` runs; on macOS `dmg` runs; on Windows `nsis` runs.

Note: `pnpm --filter ./electron pack` (without `run`) fails because `pnpm pack` is a built-in command that produces a tarball and conflicts with the filter flag. The correct invocation is `pnpm --filter ./electron run pack`. Not a bug in our config — that's standard pnpm behavior — but worth flagging for the dev workflow doc.

## Self-review

- [x] `build` block has correct `appId` (`io.agentplatform.desktop`), `productName` (`AgentPlatform`), `directories.output` (`dist-installers`), `directories.buildResources` (`build`)
- [x] `files` excludes `**/*.map` and `**/*.ts`; includes `dist/**/*`, `node_modules/**/*`, `package.json`
- [x] `extraResources` includes conduit binary (`../resources/conduit` → `conduit`, filter `conduit-*`) and renderer dist (`../renderer/dist` → `renderer`)
- [x] Mac (dmg), Linux (AppImage), Win (nsis) targets configured
- [x] Entitlements file created at `electron/build/entitlements.mac.plist`
- [x] Placeholder icon created at `electron/build/icon.png` (512×512 PNG)
- [x] Commit message matches brief exactly: `build: add electron-builder packaging config (macOS, Linux, Windows)`

## Deviations from brief

1. **Kept `--passWithNoTests` on `test` script.** The brief sample showed `vitest run --config vitest.config.ts`, but the live `package.json` already had `--passWithNoTests`. Only `dist` and `pack` were genuinely new — the rest of the scripts block was unchanged. Preserved existing config.
2. **Added `dist-installers/` to root `.gitignore`.** Brief didn't mention it, but `dist/` in `.gitignore` does not match the `dist-installers` directory name, and leaving 290 MB of unpacked Electron binaries untracked is a footgun.
3. **Brief's `pack` invocation `cd /workspace/electron && pnpm pack`** doesn't work — `pnpm pack` is pnpm's built-in tarball command. Use `pnpm run pack` (or `pnpm --filter ./electron run pack` from root) to invoke the script.

## Next steps (out of scope)

- On a macOS arm64 dev machine, run `pnpm --filter ./electron dist` to produce a real `.dmg` and verify codesign/entitlements flow end-to-end.
- Once a real icon is designed, drop a 1024×1024 `icon.icns` (macOS) / `icon.png` (Linux) / `icon.ico` (Windows) into `electron/build/` to override the placeholder.
