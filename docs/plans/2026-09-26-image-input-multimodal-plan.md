# 图片输入与多模态识别 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 输入框支持粘贴/拖入/`@` 引用图片，经结构化通道直达双平台 LLM 请求（近 2 轮可见、压缩丢弃、能力不匹配确定性降级）。

**Architecture:** 图片以 workspace 相对路径 + 降采样尺寸随 `MessageContext.images` 搭既有 context 通道（steer/resume 免费携带）；主进程 expander 读文件成 base64 进 `ExpandedContext.images`；runtime 按 `AGENT_CONFIG.vision` 快照决定带图或降级；provider 层把 `LLMMessage.images` 映射 OpenAI parts / Anthropic image blocks。

**Tech Stack:** Electron 主进程（CJS/better-sqlite3）+ React renderer（ESM/Vite）；无新 npm 依赖（降采样用 renderer canvas，尺寸解析用 Image 构造器）。

**Spec:** `docs/specs/2026-09-26-image-input-multimodal-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- Node 20 LTS；命令一律 `npx pnpm@9.0.0`
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`
- 中文注释；renderer UI 只用语义 token + lucide-react 图标（禁 emoji 图标、禁标准 Tailwind 色阶）
- electron 单测集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated
- 全量基线：electron 16 失败（5 个既有文件）/ renderer 1621 全绿——零新增失败
- 版本纪律：合入大特性只把三处 package.json alpha 号 +1，特性 commit 不动版本号
- expander「永不抛错」契约：所有图片失败路径降级 + warn，不阻塞消息派发

## Review Focus（spec 隐含但易咬人的输入类）

1. **旧消息无 images 字段**——全链路必须零行为变化（parse/rebuild/气泡兼容测试锁）
2. **图片文件被用户删除后再 rebuild**——降级占位不炸（expander 失败用例）
3. **非 vision 模型 + 带图消息**——请求体必须无 images 字段（字节级断言）+ 正文有省略提示
4. **路径逃逸**（`../`、绝对路径、符号链接）——sanitize + assertInWorkspace 双层拒绝用例
5. **无图消息的 LLM 请求字节不变**——既有回归全绿即是锁；新增映射测试显式断言 content 仍为 string

---

### Task 1: 供应商预设 vision 能力

**Files:**
- Modify: `electron/src/main/llm/provider-presets.ts`
- Test: `electron/tests/llm/provider-presets-vision.test.ts`（新建）

**Interfaces:**
- Produces: `PresetModel.vision?: boolean`（可选，缺省 false）；新条目 `zhipu.glm-4.6v` / `zhipu.glm-4.6v-flash` / `groq['qwen/qwen3.8-27b']`

- [ ] **Step 1: 写失败测试** —— vision 标志快照（spec §3.1/§3.2 全表）+ `getPresetModel('zhipu','glm-4.6v')` 返回 128K/32K
- [ ] **Step 2: 跑测试确认失败**（vision 属性不存在）
- [ ] **Step 3: 实现** —— PresetModel 加 `vision?: boolean`；按 spec §3.1 表打标；追加两个 zhipu V 条目（reasoning: NONE，注释「官方未公布输出上限，保守档」）与 groq qwen 条目
- [ ] **Step 4: 测试绿 + typecheck**

### Task 2: vision 能力解析链（DB 列 + 快照 + 成员信息）

**Files:**
- Create: `electron/src/main/storage/migrations/045_provider_models_vision.ts`（内联 SQL，注册 index.ts）
- Modify: `electron/src/main/agent/spawn-helpers.ts`（resolveVisionCapability）；`runtime-entry.ts`（AGENT_CONFIG 类型 + parseConfig）；`im/session members` 查询处（SessionMemberInfo.vision）
- Modify: `renderer/src/ipc/types.d.ts`（SessionMemberInfo.vision?: boolean）
- Modify: 模型编辑 UI（provider_models 读写处加开关）
- Test: `electron/tests/agent/spawn-helpers-vision.test.ts`（新建）、扩展 members IPC 既有测试

**Interfaces:**
- Produces: `resolveVisionCapability(providerKey: string, modelId: string, workspaceId?: string): boolean`（provider_models.vision 优先 → PresetModel.vision → false）；`AGENT_CONFIG.vision: boolean`；`SessionMemberInfo.vision: boolean`

- [ ] **Step 1: 失败测试** —— 三级优先级（DB 覆盖 1 优先于 preset 1；两者皆无 = false）
- [ ] **Step 2: 确认失败 → 实现迁移 + 解析函数 + parseConfig/spawn 接线 + members 查询补 vision + 设置 UI 开关**
- [ ] **Step 3: 测试绿 + typecheck + 全量 electron 基线核对**

### Task 3: LLMMessage.images + 双平台映射

**Files:**
- Modify: `electron/src/main/agent/llm-provider.ts`（LLMMessage、toOpenAIMessage、Anthropic mapper）
- Test: 扩展 `electron/tests/agent/llm-provider.test.ts`

**Interfaces:**
- Produces: `LLMMessage.images?: Array<{ mime: string; base64: string; w: number; h: number }>`
- OpenAI 映射：`content = [{type:'text',text}, ...images.map(i => ({type:'image_url', image_url:{url:`data:${i.mime};base64,${i.base64}`}}))]`；Anthropic：`[{type:'image',source:{type:'base64',media_type:mime,data}}, {type:'text',text}]`；无 images 时 content 保持 string（字节不变）

- [ ] **Step 1: 失败测试** —— 双平台 parts 形状 + 无图时 content typeof 'string' 深断言
- [ ] **Step 2: 实现两个 mapper 分支**
- [ ] **Step 3: 绿 + typecheck**

### Task 4: asset:saveImage IPC

**Files:**
- Create: `electron/src/main/files/asset-ipc.ts`（handler：workspaceId + Uint8Array + ext → sha1 前 12 → `.momo/assets/<hash>.<ext>`，WorkspaceFS 校验落盘，返回相对路径；同 hash 已存在直接复用）
- Modify: 主进程 IPC 注册处、`electron/src/preload/index.ts`、`renderer/src/ipc/types.d.ts` + client
- Test: `electron/tests/files/asset-ipc.test.ts`（新建：落盘/去重/逃逸拒绝/非图片扩展名拒绝）

**Interfaces:**
- Produces: `ipc.asset.saveImage(workspaceId: string, data: Uint8Array, ext: 'png'|'jpg'): Promise<{ path: string }>`（扩展名白名单 png/jpg——降采样后只有这两种，spec §5）

- [ ] **Step 1-4: TDD 同上模式**

### Task 5: 协议层 images 通道（MessageContext → ExpandedContext）

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（MessageContext.images）、`electron/src/main/im/session.ipc.handlers.ts`（sanitize）、`renderer/src/lib/message-context.ts`（parse）、`electron/src/main/agent/runtime-config.ts`（ExpandedContext.images）、`electron/src/main/im/context-expander.ts`（读图 base64 + 单图 >8MB base64 剔除 + 失败占位）
- Test: 扩展 `electron/tests/im/context-expander.test.ts`、sanitize 契约测试

**Interfaces:**
- `MessageContext.images?: Array<{ path: string; w: number; h: number }>`
- `ExpandedContext.images: Array<{ path: string; mime: string; base64: string; w: number; h: number }>`（读取失败/超限 → 不进数组 + 正文占位 `[图片加载失败: path]` 由 runtime 注入，expander 只负责剔除 + 返回失败清单）
- sanitize 规则：path 是 string 且非空、w/h 是正整数；数组上限 6

- [ ] **Step 1-4: TDD**（含旧消息无 images 字段 = undefined 兼容用例、路径逃逸拒绝用例）

### Task 6: token 估算

**Files:**
- Modify: `electron/src/main/agent/tools/shared/token-estimate.ts`
- Test: 扩展对应测试

**Interfaces:**
- Produces: `estimateImageTokens(w: number, h: number): number = max(258, ceil(w*h/750))`；消息估算累加 images

- [ ] **Step 1-3: TDD（边界 258 下限 + 典型 2048×1536 ≈ 4195）**

### Task 7: renderer 输入侧（降采样 + image pill + 粘贴/拖入 + @ 图片 + 能力提示）

**Files:**
- Create: `renderer/src/lib/image-downscale.ts`（`computeDownscalePlan(w,h,hasAlpha): {targetW,targetH,mime}` 纯函数 + `downscaleImage(file: File): Promise<{data: Uint8Array, w, h, ext}>` canvas 实现）+ colocated test（纯函数全覆盖；canvas 逻辑 jsdom 不可测，留真机）
- Modify: `composer-segments.ts`（PillKind 'image'、序列化 body 锚点 `[图片: name]` + context.images 去重保序、draftToSegments 白名单、ComposerPayload.images）
- Modify: `RichComposer.tsx`（onPaste/onDrop → `onImageFiles(files: File[])` prop 上抛；image pill 缩略图渲染——buildPillNode 分支 + PILL_CLASS）
- Modify: `MentionInput.tsx`（粘贴/拖入管线：上限 6 → downscale → ipc.asset.saveImage → insertPill('image')；@ 菜单图片扩展名条目图标差异 + 选中进 images 通道；能力提示行——SessionMemberInfo.vision 全 false 时显示）
- Modify: `session.store.ts` sendMessage 载荷透传 images
- Test: 扩展 `composer-segments.test.ts`、`RichComposer.test.tsx`（paste 事件上抛）、`MentionInput.test.tsx`（image pill 序列化 + @ 图片分流 + 上限拦截 + 提示行）

**Interfaces:**
- Consumes: Task 4 `ipc.asset.saveImage`、Task 2 `SessionMemberInfo.vision`
- Produces: `ComposerPayload.images?: Array<{ path: string; w: number; h: number }>`；image pill：`{type:'pill', kind:'image', id: path, label: 文件名}`（w/h 存 pill 扩展字段 `w`/`h`——pill 序列化时进 images）

- [ ] **Step 1-5: TDD 分四批**（segments 序列化 → RichComposer paste 上抛 → MentionInput 管线 → 提示行），每批先失败测试后实现
- [ ] **Step 6: typecheck + renderer 全量 1621+新增 全绿**

### Task 8: runtime 注入、降级与团队路由

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（runChatLoop 当前轮 user message 挂 images；AGENT_CONFIG.vision=false → 剥图 + 正文尾注 `[图片已省略：当前模型不支持视觉]`；leader 场景注入路由提示）
- Modify: `router-service.ts`（routeUserChat 构造 task-config 时附 `visionHint`：团队会话 + 接待者非 vision + 消息带图 + 存在 vision 成员 → `visionHint: { members: Array<{name, model}> }`，runtime 据此渲染提示文本）
- Test: 扩展 `electron/tests/agent/runtime-task-driven.test.ts`（非 vision 剥图字节断言、visionHint 注入文本、无 hint 时零变化）

- [ ] **Step 1-4: TDD**

### Task 9: 近 2 轮重发 + dispatch 附图 + 压缩占位

**Files:**
- Modify: 会话重建处（rebuildSessionContext / turn-reconstructor）：最后 2 条 user 消息 context_json.images → expander 恢复 base64 → LLMMessage.images
- Modify: `router-service.ts` routeDispatch：合会话近 2 轮 images，按目标 agent vision 过滤（false → path 占位不传 base64）
- Modify: compaction 序列化：images → `[图片: path]` 文本占位
- Test: 扩展对应三处测试（窗口边界：第 3 条 user 消息不恢复；压缩占位；dispatch 过滤）

- [ ] **Step 1-4: TDD**

### Task 10: 气泡缩略图 + 收尾

**Files:**
- Create: `electron/src/main/files/asset-read-ipc.ts`（`asset:readDataUrl(workspaceId, path)`——仅 `.momo/assets/` 前缀放行，返回 data URL）+ preload/types
- Modify: `renderer/src/components/im/MessageBubble.tsx`（context_json.images 缩略图行，max-w-60 圆角，onerror 占位样式）
- Test: `MessageBubble.test.tsx` 扩展（mock ipc；无 images 旧消息零变化）

- [ ] **Step 1-3: TDD**
- [ ] **Step 4: 双 workspace typecheck + electron/renderer 全量基线核对**
- [ ] **Step 5: dev 重启（ABI electron）+ 真机剧本**：粘贴截图 → glm-4.6v 会话描述正确；gpt-5.2 追问第 2 轮仍可见、第 3 轮降占位；非 vision agent 发图看到省略提示 + 团队路由提示；@图片文件分流验证
- [ ] **Step 6: alpha 号 +1（三处 package.json，用户确认发版语义时按 release.md）**

---

## Self-Review 记录

- Spec 覆盖：§3→T1/T2；§4 数据流各段→T4/T5/T7/T8；§5→T4/T7；§6→T5/T7；§7→T3/T8；§8→T2/T8；§9→T6/T9；§10→T7/T10；§11→各任务失败用例；§12→各任务测试 + T10 真机；§13 不做项无任务 ✓
- 类型一致性：MessageContext.images / ExpandedContext.images / LLMMessage.images 三层形状已在 T5/T3 接口块对齐（w/h 全程随行）
- Review Focus 落位：旧消息兼容→T5/T9/T10；删图降级→T5/T9；非 vision 字节断言→T8；路径逃逸→T4/T5；无图字节不变→T3 既有回归 + 显式断言
