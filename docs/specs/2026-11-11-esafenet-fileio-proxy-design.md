# 亿赛通加密环境文件代理读写（File IO Proxy）设计方案

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 编写日期 | 2026-11-11 |
| 状态 | 设计已确认，待实施 |
| 上游输入 | `/Users/stbearangel/dev/AiProject/momo-studio-亿赛通方案/`（momo 实测 PoC：README.md + file-io.js + io-worker.js + test.js） |
| 目标环境 | 已部署亿赛通 Cobra DocGuard 5.2 的 Windows 研发内网 |

---

## 1. 背景与问题

### 1.1 现象

研发内网使用亿赛通电子文档安全管理系统（Cobra DocGuard，下称 CDG）做源码透明加密。momo-studio（Electron，进程名 `momo-studio.exe`）不在 CDG 受控进程名单内：

- **读**：`.java` 等受控后缀文件读到的是 `E-SafeNet` 容器密文（乱码）——文件面板打不开、agent 无法分析代码；
- **写**：见 §3.2——标准策略下非受控进程写入**静默落明文**（DLP 违规）——agent 改码后落盘形态错误。

### 1.2 环境事实（已实测确认，2026-11-11）

| 项 | 实测值 |
|---|---|
| CDG 白名单判定 | **可执行文件名精确匹配（大小写不敏感）**；与路径/签名/哈希无关（当前策略未开签名校验） |
| `node.exe` | ✅ 在白名单，`fs.readFileSync` 直接得明文（驱动层解密，开销 1.01x 可忽略） |
| `momo-studio.exe` | ❌ 不在白名单 |
| git / 构建工具链 | ✅ 已由 IT 加入白名单，正常使用（密文入库 + 编译进程白名单是该产品设计意图） |
| 方案 A（申请将 momo-studio.exe 加白名单） | ❌ 不可行——公司策略不接受自研工具进白名单 |
| 加密覆盖范围 | 后端仓库 `.java` 98.9% 加密；`.md/.xml/.sql/.yml/.json/前端代码` 全部明文（按现状，设计仍按「任意文件可能加密」通用处理） |
| 合规状态 | proxy 模式已口头同意，书面确认流程进行中（P0 发布门禁） |
| 系统 Node.js | 研发机可自行安装（实测机为 v14.21.3——**worker 必须保持 Node ≥ 14 兼容**） |

### 1.3 上游 PoC 的价值与缺口

momo 已交付实测 PoC（FileIoService 三档模式 + 常驻 node.exe worker + 密文硬失败 + 性能数据），可直接沿用。但它是「主进程单进程视角」，存在三个缺口：

1. **写路径未验证**：`io-worker.js` 只有 read；`writeFile` 是主进程（非白名单）直写。PoC 测试 6 通过是因为测试本身跑在 node.exe 内——写入方实际是白名单进程，真实场景不成立。
2. **agent 链路未覆盖**：momo-studio 里读代码的主体是 fork 出的 runtime 子进程，不是主进程。
3. **多进程 worker 拓扑未设计**：PoC 假设单进程持有 worker。

本方案补齐以上三点。

---

## 2. 现状盘点：momo-studio 文件 I/O 全触点

### 2.1 进程模型（触码进程全部非白名单）

```
momo-studio.exe（Electron 主进程）                 ← 非白名单
 ├─ file:* IPC handlers（文件面板/编辑器）
 ├─ im/context-expander（消息上下文展开）
 ├─ journal/revert（变更账本回滚）
 ├─ files/asset-read-ipc、hub/view-server
 └─ fork × N（WarmPool K=2/agent，经 process.execPath）
     └─ runtime 子进程同样是 momo-studio.exe 镜像   ← 非白名单
         └─ agent 工具 read_file / write_file / apply_patch 在子进程内执行
```

关键代码事实：

- `runtime-spawner.ts` 的 `spawnForAgent` 经 `fork(process.execPath)` 拉起 runtime——打包后 execPath 即 momo-studio.exe；
- 工具模块（含 FileTools / ApplyPatchTools）在 runtime 子进程内加载执行，子进程侧自建 `WorkspaceFS` 实例（`buildRuntimeContext` → `new WorkspaceFS`）；
- 既有子进程→主进程桥先例（本方案复用同构模式）：`mcp-bridge`、`process-bridge`、`plugin-hook-bridge`——均为 **id 配对请求/响应 over fork IPC**。

### 2.2 收口点：WorkspaceFS

`electron/src/main/files/workspace-fs.ts` 的 `WorkspaceFS` 是应用层文件沙箱，**主进程与子进程的文件内容读写全部收口于它**（83 处调用）。方法分类：

| 方法 | 是否触碰文件内容 | 加密环境影响 | 本方案处理 |
|---|---|---|---|
| `readFile` / `writeFile` / `createFile` | ✅ | 读得密文 / 写落明文 | **按模式路由**（§5.3） |
| `listDir` / `searchNames` | ❌ 仅目录元数据/文件名 | 无影响（文件名不加密） | 不动 |
| `rename` / `deletePath` / `createDir` / `assertInWorkspace` | ❌ | 无影响 | 不动 |

### 2.3 消费面矩阵（momo-feature-scope-rules）

| 消费面 | 走 WorkspaceFS？ | proxy 模式下覆盖 |
|---|---|---|
| 文件面板 / 编辑器（`file:read` / `file:readForEditor` / `file:write` / `file:create`） | ✅ | ✅ 自动 |
| agent 文件工具（read_file / write_file / edit_file） | ✅ 子进程侧 | ✅ 经桥（§5.4） |
| agent apply_patch | ✅ 子进程侧 | ✅ 经桥 |
| context-expander（消息上下文读文件） | ✅ | ✅ 自动 |
| journal revert（回滚写文件） | ✅ | ✅ 自动 |
| asset-read / hub view-server | ✅ | ✅ 自动 |
| **bash 工具内 `cat` / `grep` 等命令** | ❌ 独立进程（bash.exe） | ❌ 不覆盖（§9 已知限制） |
| **插件工具 / MCP server 进程内自行 fs 读写** | ❌ | ❌ 不覆盖（§9 已知限制） |
| git / 构建工具 | — 已在系统白名单 | 无需处理 |

---

## 3. 外部调研结论（写路径语义，2026-11-11 librarian 调研）

### 3.1 加解密判定矩阵（官方手册 V11 + 4 份独立逆向交叉验证）

| | 受控后缀 | 非受控后缀 |
|---|---|---|
| **进程在受控名单** | 读解密、写加密 | 不加解密 |
| **进程不在名单** | 读得密文；**写不阻断、不自动加密——明文静默落盘** | 不加解密 |

**推论**：主进程直写受控文件 = 静默 DLP 违规且无任何报错。**proxy 模式下写必须同样经 node.exe worker**（白名单进程写入由驱动落盘前加密），这不是优化项，是必需项。

### 3.2 三个环境相关风险

1. **DynamicDll64.dll 经 PATH 注入**：CDG 向白名单进程注入该 DLL 且按 PATH 加载；PATH 被裁剪的进程会 `0xc0000135` 崩溃（vcpkg 真实案例）。→ **硬性实现约束：spawn worker 时 `env` 必须完整继承主进程 PATH，禁止任何 sanitize**。
2. **进程签名策略**：若企业开启进程签名校验（手册有此功能、当前环境未开），未签名 node.exe 代理会「打开文件报错」→ proxy 失效。→ 依赖密文硬失败 `EENCRYPTED` 兜底 + §7 验证清单。
3. **落地加密策略差异**：若仓库路径配了路径驱动的落地加密，非白名单写也会被自动加密，行为不同且应用侧无法静态推断。→ 首次部署必须跑「写入探针」（§7.3）。

### 3.3 对本方案的利好

CDG 标准策略**不含子进程继承**——node.exe 单点获权、momo-studio.exe 全链保持无权限，授权面最小，且与「proxy 只借用已授权通道」的合规口径一致。

---

## 4. 方案对比与选型

| | 方案 1：主进程单例 + 子进程桥接（✅ 选定） | 方案 2：每 runtime 子进程自带 worker | 方案 3：文件工具全部上移主进程执行 |
|---|---|---|---|
| 架构 | FileIoService 仅主进程持有 1 个常驻 node.exe worker；子进程 WorkspaceFS 经 child→main 桥转发 | 每个子进程内嵌 FileIoService 各自 spawn worker | FileTools/ApplyPatchTools 改为全桥接主进程执行 |
| 进程数 | **1 个 worker** | K=2 × N agent 个，内存/泄漏风险放大 | 1 个 |
| 改造面 | WorkspaceFS 三方法 + 一个新桥（同构既有 3 个桥） | WorkspaceFS + AGENT_CONFIG + 子进程 worker 生命周期 | 重构工具执行层，触碰沙箱/write-grant 门禁 |
| 性能 | 子进程读写多一跳（+0.1~0.3ms/文件，不可感知；PoC 实测 IPC 单次 0.19ms） | 每子进程冷启动 +142ms | 每次工具调用都过桥 |
| 结论 | **改造集中、进程拓扑最简、与既有桥模式同构** | 进程数失控 | 违背「工具在子进程执行」架构方向，风险最大 |

---

## 5. 总体设计

### 5.1 架构

```
┌────────────────────────────────────────────────────────────┐
│ momo-studio.exe 主进程（非白名单）                           │
│                                                            │
│  WorkspaceFS(主进程实例) ──┐                               │
│  file:* IPC / expander /   │   FileIoService（单例）        │
│  journal / hub / asset     ├──▶ mode 路由 + 密文硬失败      │
│                            │        │                      │
│  fork IPC ◀── file-io-bridge 消息分支（id 配对）            │
│      ▲                     │        │                      │
│      │ 子进程 WorkspaceFS ──┘        │ spawn（env.PATH 完整继承）
└──────┼──────────────────────────────┼──────────────────────┘
       │ fork IPC                      │ stdin/stdout JSON-lines
┌──────┴──────────────┐   ┌───────────▼──────────┐
│ runtime 子进程 × N   │   │ node.exe worker × 1   │
│ （momo-studio.exe    │   │ （白名单）             │
│  镜像，非白名单）      │   │ read / write / stat   │
│  FileTools 等        │   │ 驱动自动加解密         │
└─────────────────────┘   └───────────────────────┘
```

### 5.2 模块落位

```
electron/src/main/files/file-io/
├── file-io-service.ts    # 主进程单例：模式路由 / worker 生命周期 / 密文硬失败 / 批量
├── io-worker.ts          # 白名单代理进程脚本（Node ≥ 14 兼容，不依赖任何 npm 包）
├── file-io-bridge.ts     # 子进程侧桥（同构 process-bridge / mcp-bridge）
├── cipher-detect.ts      # E-SafeNet 魔数检测（looksEncrypted，直读/代理读共用）
└── file-io-settings.ts   # GlobalSettings.fileIo 读取 + 模式解析（direct/proxy/auto + 环境探测）
```

TypeScript strict，禁止 `any` / `as any`。PoC 的 JS 实现按 TS strict 重写移植，语义不变。

### 5.3 WorkspaceFS 收口改造

`WorkspaceFS` 构造注入可选 `contentIo`（内容读写通道接口，缺省 = 本地 fs，即 direct 行为）：

- `readFile`：direct → 本地 `fs.promises.readFile` + 魔数校验；proxy → 经 contentIo（主进程实例直连 FileIoService；子进程实例经 file-io-bridge）+ 魔数校验；
- `writeFile` / `createFile`：direct → 本地写；proxy → 经 contentIo 写（worker 内 `fs.writeFileSync` → 驱动加密落盘）；
- 其余方法（listDir / searchNames / rename / deletePath / createDir / assertInWorkspace）不动——沙箱校验与路径规范化语义保持主进程本地执行。

**魔数硬失败（全链路）**：任一模式读到 `E-SafeNet` 容器即抛 `EENCRYPTED`，绝不静默返回乱码、绝不静默降级。

### 5.4 子进程桥（file-io-bridge）

- 消息形态同构既有桥：子进程 `{type:'file-io:req', id, op:'read'|'write'|'readMany', ...}` → 主进程 handler 执行 FileIoService → `{type:'file-io:resp', id, ok, data|error}` 回写；
- handler 挂在 `runtime-spawner.ts` 的 `messageHandler` 分支链（与 plugin/process/mcp 分支并列，前缀同步门卫）；
- 子进程模式经 **AGENT_CONFIG spawn 快照**下发（`spawnForAgent` 现有机制加一个字段）；模式为 direct 时桥零开销（子进程本地读写 + 硬失败）；
- `readMany` 支持批量（context-expander 场景摊薄 IPC，batch=50 沿用 PoC 实测结论）。

### 5.5 worker 协议（io-worker）

stdin/stdout 逐行 JSON（沿用 PoC，扩展 op）：

```jsonc
// 请求
{ "id": 1, "op": "read", "path": "..." }                      // → {ok, dataBase64, size}
{ "id": 2, "op": "readMany", "paths": ["..."] }               // → {ok, items:[{ok, dataBase64, size|error}]}
{ "id": 3, "op": "write", "path": "...", "dataBase64": "..." } // → {ok, size}
{ "id": 4, "op": "stat", "path": "..." }                      // → {ok, size, mtimeMs}（大文件分块预留）
```

约束：Node ≥ 14 语法（无 top-level await / AbortController 依赖）；不 require 任何外部包；`windowsHide: true`；**spawn env 完整继承（PATH 不动，§3.2 硬约束）**。

### 5.6 模式与配置

存储走既有全局设置管道（`kv_store.global_settings` JSON 增量字段，复用 `getGlobalSettings` / `updateGlobalSettings` / `ipc.settings.updateGlobal`）：

```typescript
fileIo?: {
  mode: 'direct' | 'proxy' | 'auto';   // 缺省 'direct'
  nodePath?: string;                    // 缺省自动探测（PATH + 常见安装位 + 可用性验证）
  strictCipherCheck?: boolean;          // 缺省 true
}
```

- **默认 direct**：未加密环境零行为变化；proxy 显式开启（合规边界可见、可审计）；
- `auto`：探测到 CDG 客户端目录存在 → proxy，否则 direct；
- 模式变更：主进程即时生效；子进程随下一次 spawn 的 AGENT_CONFIG 快照生效（存量 runtime 本轮任务跑完自然换代，不中断）。

**设置 UI**：设置页新增「文件访问」面板，同构 `SandboxSettingsPanel`（三档 radio + nodePath 输入 + 状态探针卡「代理环境 / node.exe 可用性 / 生效模式 + 重新检测」）。

**UI 文案中性化（硬性约束）**：用户可见文案只写技术语义（「通过 node 代理读写文件」），**不出现**「亿赛通 / 加密 / 安全部门 / 白名单 / 合规批准」等字样；具体原因（CDG 检测结果、策略变更、白名单状态）只落 electron-log。错误文案示例：

> 「文件为加密格式，无法读取。请在 设置 → 文件访问 切换为 Node 代理模式，或联系管理员。」

UI 变更受 momo-ui-preview-rules 预览门禁约束（新面板属 P1 变更，实现前出静态预览确认）。

### 5.7 错误处理契约

沿用 PoC 错误码并补全：

| 错误码 | 含义 | 处置 |
|---|---|---|
| `EENCRYPTED` | 读到密文（通道不对/策略变更） | 硬失败 + 指引文案（UI 中性化，日志详因） |
| `ENONODE` | proxy 需要的系统 node.exe 未找到 | 设置面板 nodePath 配置 / 提示安装 |
| `ENOWORKER` | worker 脚本缺失 | 安装完整性问题，报错 |
| `ESPAWN` | worker 启动失败 | 检查 nodePath / 权限 |
| `ECHILD` | worker 异常退出/被强杀 | 后续请求立即失败（不挂死）；下次请求自动重启 worker |
| `ETIMEOUT` | 请求超时（默认 30s） | 检查大文件/磁盘 |
| `EREAD` / `EWRITE` | 读写失败 | 路径/权限 |
| `EBADMODE` | 模式配置非法 | 设置回退 direct 并告警 |

所有错误经桥透传到子进程侧（桥协议 error 载荷带 code），agent 工具输出可见。

### 5.8 生命周期

- FileIoService 主进程单例，懒启动（首次 proxy 请求时 spawn worker），常驻复用（spawn 142ms 冷启动不可接受逐请求 spawn——PoC 实测）；
- worker `exit`/`error` 监听：pendings 全部 `ECHILD` reject；下次请求自动重启（自愈，不静默降级 direct）；
- `app.on('will-quit')` 调 `close()`（stdin.end + kill，防孤儿 node.exe）；
- 测试 teardown 同样走 close()。

---

## 6. 安全与合规

1. **P0 发布门禁**：proxy 模式进入正式发布版本前，必须取得安全部门书面确认（口径：借用已授权 node.exe 通道，不破解/不伪造/不篡改 CDG）。开发与内网验证不受此阻塞。
2. **明文不落盘**：明文全程内存管道（worker → stdout base64 → 主进程 Buffer → IPC），不写任何临时文件。
3. **明文外传边界**：momo-studio 现有 LLM 调用走研发网内网端点；spec 不改变数据流向。若未来接入外网模型，需另做 DLP 评估（超出本方案范围，风险表留痕）。
4. **禁止事项**（PoC §3.3 继承）：不改名伪装白名单进程、不伪造签名、不注入 CDG、不改 Policy.dat。
5. **审计留痕**：CDG 侧对 node.exe 的解密行为有服务端审计（属正常现象，事先与安全部门同步）。

---

## 7. 测试与验收

### 7.1 单元测试（electron/tests/files/，镜像 src 结构）

遵循 momo-test-rules（mock 仿真真实运行时语义）：

- cipher-detect：魔数边界（< 12 字节 / 恰好 64 字节 / 明文误判）；
- file-io-service：模式解析（direct/proxy/auto 探测 mock）、worker 协议编解码、批量分片（batch=50）、超时、worker 被杀后 `ECHILD` + 自愈重启、**env.PATH 完整继承断言**（专项回归锁，防 vcpkg 同款 0xc0000135）；
- 桥：id 配对、错误透传（code 保留）、通道关闭防御；
- WorkspaceFS 收口：direct 行为不变（既有 workspace-fs.test 全绿不回归）、proxy 路由、EENCRYPTED 硬失败文案；
- mock 策略：spawn 用注入式 fake child（真实 stdin/stdout 逐行语义 + this 绑定），不用简化 stub。

### 7.2 容器/未加密环境验收（P1/P2 出口）

- 未装 CDG 机器：`.md/.xml/.sql/.java` direct 模式全部正常读写；
- direct 模式读密文样本 → `EENCRYPTED`（不是乱码）；
- 默认配置下（direct）不 spawn worker、退出无残留子进程；
- 全量 `pnpm typecheck` + 两 workspace 测试绿。

### 7.3 研发机实测验收（P3 出口，真实 CDG 环境）

- [ ] proxy 读加密 `.java` 得明文（package 声明完整），文件面板可打开/编辑/保存；
- [ ] **写入探针**：proxy 写探针文件 → node 读回一致 + 磁盘字节为密文形态 + 白名单工具（IDE/git diff）读回一致；
- [ ] agent 端到端：read_file / apply_patch 全链路（子进程→桥→worker）读写正常；
- [ ] 批量 300 文件 < 200ms；全量 7,000 文件无内存泄漏、无残留 node.exe；
- [ ] 应用退出后 worker 被回收；
- [ ] **环境变更清单固化**（CDG 升级/策略变更后重跑）：node.exe 仍读得明文 / 密文硬失败仍生效 / 写入探针仍一致——固化为 `scripts/` 下冒烟脚本 + 文档清单（上游 PoC §8.3 继承）。

---

## 8. 分期计划

| 阶段 | 内容 | 出口 |
|---|---|---|
| P0 | 书面合规确认（与开发并行，仅卡发布） | 安全部门书面答复 |
| P1 | file-io 模块移植（TS strict）+ cipher-detect + 单测（不接线） | §7.1 对应用例绿 |
| P2 | WorkspaceFS 收口 + file-io-bridge + AGENT_CONFIG 下发 + 设置面板（预览门禁）+ 错误 UI | §7.2 全绿 |
| P3 | 研发机实测（写路径验证是重点） | §7.3 清单全过 |
| P4 | 灰度：默认 direct，目标机器经设置显式开 proxy | 灰度反馈闭环 |

---

## 9. 已知限制（明示）

1. **bash 内 `cat`/`grep` 等命令读受控文件仍得密文**（bash.exe 不在白名单）。缓解：agent 提示词引导优先使用 read_file 工具；后续增强可在 worker 增加内容检索 op（不在本期范围）。
2. **插件工具 / MCP server 进程内自行 fs 读写不受保护**——插件规范应要求使用注入的文件通道（文档声明，暂不强制）。
3. **进程签名策略开启则 proxy 失效**（当前环境未开）——`EENCRYPTED` 硬失败保证快速暴露，§7.3 清单覆盖。
4. **模式快照语义**：子进程模式随 spawn 定型，运行中切模式对存量 runtime 不即时生效（本轮任务跑完自然换代）。

---

## 10. 风险表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 书面合规未落地 | 发布阻塞（不阻塞开发） | P0 门禁独立跟踪 |
| CDG 策略变更（签名校验开启） | proxy 失效 | 密文硬失败 + §7.3 环境变更清单 |
| worker PATH 被裁剪 | 注入 DLL 加载失败崩溃 | env 完整继承 + 专项回归测试 |
| 落地加密等策略组合差异 | 写行为不同 | 首次部署写入探针强制验证 |
| 系统 node 缺失/版本过老 | proxy 不可用 | ENONODE 明确报错；worker 保持 Node ≥ 14 兼容 |
| worker 孤儿进程 | 资源泄漏 | will-quit close + exit 监听 + 测试断言 |
| 大文件传输慢 | 单次 4ms+（445KB 实测） | 可接受；stat op 为分块预留 |

---

## 附：关键实测数据（继承上游 PoC，2026-11-11）

| 指标 | 数值 |
|---|---|
| 解密开销 | 1.01x（+2µs/文件，驱动层完成） |
| IPC 额外开销 | +0.19ms/小文件；+4.06ms/445KB 大文件 |
| node 冷启动 | 142ms（必须常驻 worker） |
| 批量策略 | batch=50 → 1.39x（收益饱和点） |
| 逐请求 spawn | ~790x 退化（禁用） |
