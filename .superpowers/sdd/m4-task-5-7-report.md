# M4 Task 5-7 实施报告

分支：`feat/m4-marketplace`，base：`324c94b`

## 交付物

### T5 — Marketplace UI（commit `119595a`）

| 文件 | 说明 |
|---|---|
| `renderer/src/stores/marketplace.store.ts` | zustand store：loadCatalog / loadInstalled / setQuery / setTypeFilter / install / uninstall；前端过滤 catalog.items（搜索按键不打 IPC） |
| `renderer/src/components/marketplace/MarketplaceView.tsx` | 搜索栏 + 类型 tabs（全部/Agent/MCP/Skill）+ 卡片网格 + 选中右侧详情；进入视图自动 loadCatalog |
| `renderer/src/components/marketplace/ItemCard.tsx` | icon + name + description + 校验徽章（官方/已验证/社区/未验证）+ 安装按钮；复用 Button + cn |
| `renderer/src/components/marketplace/ItemDetail.tsx` | react-markdown + remark-gfm 渲染 readme + 元信息（slug/版本/作者/大小/标签）+ 安装/卸载按钮 |
| `renderer/src/components/layout/MiddlePanel.tsx` | `activeView === 'marketplace'` 分支渲染 `<MarketplaceView />`（置于 workspace 守卫之前，marketplace 不依赖 workspace） |

### T6 — 安装后自动注册（commit `ed0335a`）

`electron/src/main/marketplace/installer.ts` 的 `installPackage` 成功写 `.installed` + DB 记录后调用 `registerInstalledPackage(item, cachePath)`，按 type 分发：
- **agent**：`parseAgentManifest(readFileSync(cachePath/manifest.yaml))` → `saveAgentDefinition`（`source='marketplace'`）
- **skill**：写 `skill_definitions` 表（id/slug/version/description/cache_path/tags）
- **mcp**：读 `cachePath/package.json` → `registerMcpDefinition({command:'npx', args:[pkg.name]})`

注册整体包在 try/catch 内，**失败仅 `logger.warn` 不阻断安装**。`AgentDefinition.source` 类型从 `'builtin' | 'custom'` 扩展为 `'builtin' | 'custom' | 'marketplace'`（`electron/src/main/agent/types.ts`）。

### T7 — electron-builder 打包最终化（commit `942a1ec`）

`electron/package.json` 的 `build.extraResources`：
- **新增** `../resources/marketplace → marketplace`（catalog.json 被包含）
- **保留** `./resources/agents → agents`（3 个 YAML 已包含）
- **修复** conduit filter：`["conduit-*"]` → `["static-*", "conduit-*"]`。原 filter 匹配不到实际二进制（conduwuit 发布名为 `static-{arch}-unknown-linux-musl`，download.ts 下载的就是 `static-*`）

## 验证结果

| 验证 | 结果 |
|---|---|
| `pnpm typecheck`（两个 workspace） | ✓ 通过 |
| `pnpm test` | ✓ 191/191 通过（35 文件） |
| `pnpm build` | ✓ tsc + vite build 成功 |
| `pnpm --filter @ap/electron pack` | ✓ electron-builder `--dir` 成功；解包目录 `dist-installers/linux-arm64-unpacked/resources/` 验证：`marketplace/catalog.json` ✓、`agents/*.yaml` ✓、`conduit/static-aarch64-unknown-linux-musl` ✓、`renderer/` ✓ |

## 环境备注

- `better-sqlite3` 必须在 Node 20 下 rebuild（容器默认 Node 26 会 `ERR_DLOPEN_FAILED`）：`nvm use 20 && pnpm rebuild better-sqlite3`
- electron-builder 首次运行需联网下载 Electron 二进制（GitHub release），容器网络不稳时可能需重试；二进制缓存后 `~/.cache/electron/` 后续不再下载
