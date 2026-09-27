# 图片输入与多模态识别设计（输入框可用性 P0 ③）

- 日期：2026-09-26
- 状态：待用户审定
- 上游：输入框可用性三痛点之 ③（①IME 组合提交检测失效、②菜单键盘导航已于同日修复合入，见 RichComposer / MentionInput）
- 版本纪律：特性合入时三处 package.json alpha 号 +1（`docs/dev/release.md` 研发期策略），本 spec 不定终版号

## 1. 背景与目标

用户在会话输入框需要两类图片来源入口，并让多模态 LLM 真正「看到」图片：

1. **剪贴板粘贴 / 拖入**：截图或本地图片直接 Ctrl+V / 拖放进输入框
2. **@ 图片文件**：`@` 统一菜单引用 workspace 内图片文件

现状瓶颈：全管线纯文本——`MessageContext.files` 以 utf-8 内联（图片变乱码）、`LLMMessage.content` 是 string、双平台请求映射无 parts 概念、压缩/记忆/token 估算均假设纯文本。

**目标**：图片以结构化通道直达 LLM 请求（OpenAI `image_url` / Anthropic `image` block），近期轮次可见、压缩时丢弃，能力不匹配时确定性降级且给团队路由信息。

## 2. 语义决策（已与用户对齐）

| 决策点 | 结论 |
|---|---|
| 会话语义 | **近期可见、压缩丢弃**：当前轮 + 重放历史最后 2 条 user 消息（§9 近 2 轮窗口，不含当前轮——请求内最多 3 条带图面，累计 ≤6 张）；更早轮次与压缩后历史只留 `[图片: name]` 文本占位（2026-09-26 实现口径勘误：原文「最近 2 条 user 消息（含当前轮）」与 §9 窗口定义不一致，以 §9 为准） |
| 平台覆盖 | OpenAI 兼容 + Anthropic 双映射；智谱预设补 V 模型条目 |
| 图片存储 | **A1：workspace `.momo/assets/`**（内容寻址），与 @图片文件 统一为 workspace 相对路径，复用 WorkspaceFS 单一信任边界 |
| 能力发现 | vision 是 (provider, model) 属性，spawn 时快照进 AGENT_CONFIG，runtime 全链路判定；模型自身无感知 |

## 3. 供应商 vision 能力表（2026-09-26 调研，11 家官方文档核对）

### 3.1 既有预设条目标志

| 供应商 | vision=true | vision=false |
|---|---|---|
| zhipu | glm-5.3（GLM-5 系自 5.3 起原生多模态） | glm-5.2（疑似文本主线）、glm-4.7、glm-4.6、glm-4.5 |
| deepseek | deepseek-v4-flash（=deepseek-flash，1M/384K 视觉） | deepseek-v4-pro、deepseek-chat、deepseek-reasoner |
| moonshot | kimi-k3、kimi-k2.6 | kimi-k2（已退役） |
| dashscope | qwen3-max、qwen-plus | — |
| volcano-ark | doubao-seed-1-6-250615、doubao-seed-1-6-flash-250615 | — |
| openai | gpt-5.2、gpt-5.1、gpt-5-mini、gpt-4.1、gpt-4o | — |
| anthropic | claude-opus-4-5、claude-sonnet-4-5、claude-haiku-4-5 | — |
| gemini | gemini-3.1-pro-preview、gemini-3-flash-preview | — |
| xai | grok-4.6 | — |
| mistral | magistral-medium-latest | mistral-large-latest |
| groq | — | llama-3.3-70b-versatile、openai/gpt-oss-120b（未验证，默认 false） |

### 3.2 新增预设条目（仅补「该供应商唯一视觉路径缺失」）

| 条目 | contextWindow | outputTokens | reasoning | 备注 |
|---|---|---|---|---|
| zhipu `glm-4.6v` | 128K | 32K（官方未公布，保守档，用户可覆盖） | NONE | GLM-V 开源主线 |
| zhipu `glm-4.6v-flash` | 128K | 16K（同上保守档） | NONE | 9B Flash 变体 |
| groq `qwen/qwen3.8-27b` | 131K | 32K（保守档） | NONE | Groq 唯一视觉模型；平面 2048 tok/图、限 3 图/请求、单图 ≤20MB |
| zhipu `glm-5.3-flash` | 1M | 128K | effort(low/high/max, default max) | 2026-09-26 P0 补录：GLM-5 系首个原生多模态（图像/视频/文件），官方 docs.bigmodel.cn |
| zhipu `glm-5.3-flashx` | 1M | 128K | 同上 | 同上（200 tok/s 变体） |

**刻意不加**（主线已多模态或规格未核实，留作未来可选）：qwen3-vl-max/plus、doubao-seed-1.6-vision-250815、pixtral-large/12b、glm-5v-turbo、mistral-medium-latest。

### 3.3 用户自建模型

`provider_models` 表加 `vision` 列 + 迁移；模型编辑 UI 加「视觉输入」开关。解析优先级（**2026-09-26 P0 修正确认为三态**，迁移 046）：`vision=1`（用户显式开）→ true；`vision=0`（用户显式关）→ false；`NULL`/无行（未决定——种子行与旧默认 0 行归此态）→ `PresetModel.vision` → false。种子行一律 NULL（能力真相随预设表，预设翻转可传导）。

调研来源：api-docs.deepseek.com、platform.moonshot.cn、help.aliyun.com、docs.x.ai、ai.google.dev（2026-09-24 更新）、docs.mistral.ai、console.groq.com、platform.claude.com、github.com/zai-org/GLM-V、volcengine.com（智谱/火山/OpenAI 为中等置信度交叉验证，已在条目保守取值）。

## 4. 架构总览（数据流）

```
粘贴/拖入 ──┐
            ├→ renderer canvas 降采样（长边≤2048，JPEG q85 / PNG 保透明）
@ 菜单图片 ──┘        │
                     ▼ IPC asset:saveImage(buffer, meta)
             主进程 WorkspaceFS 落盘 <workspace>/.momo/assets/<sha1[0:12]>.<ext>
                     │ 返回相对路径
                     ▼
     image pill（kind='image'）→ serializeSegments → body 锚点 [图片: name]
                                             + context.images: [{path,w,h}]
                     ▼ IPC session.send（既有通道，载荷加 images）
        sanitizeMessageContext 元素级过滤 → messages.context_json 并列存 images
                     ▼ RouterService.routeUserChat（既有）
        expandMessageContext：读文件→base64→ExpandedContext.images（永不抛错）
                     ▼ TaskConfig.context（steer / resume 免费携带）
        runChatLoop：当前轮 user LLMMessage.images
        rebuild：近 2 轮 user 消息 context_json.images 恢复 base64 重发
                     ▼
        OpenAI: content=[{text},{image_url:dataURL}] / Anthropic: [{image block},{text}]
```

## 5. 存储层

- **路径规则**：`<workspace>/.momo/assets/<sha1[0:12]>.<ext>`，sha1 为降采样后内容——同图重贴不重复落盘（内容寻址去重）
- **写入**：新 IPC `asset:saveImage`（preload 白名单 + 类型声明），主进程 handler 经 `WorkspaceFS` 校验落盘；`.momo/` 命中既有 dotfile 允许逻辑（I4 语义）
- **降采样**（renderer，canvas）：长边 >2048 缩到 2048；有 alpha 通道保 PNG，否则 JPEG q85；GIF 取首帧（canvas 自然行为）；原始文件 >20MB 拒绝并提示（性能保护）
- **@ 菜单**：文件组对图片扩展名（png/jpg/jpeg/webp/gif/bmp）条目加视觉图标差异，选中 → `context.images`（不再进 files 文本通道）；`@` 的 searchNames 结果里图片文件照常命中
- **git 污染提示**：`.momo/assets` 属用户 git 工作区，设置页与文档提示 `echo '.momo/' >> .gitignore`（不代写用户 .gitignore）
  - 2026-09-26 实现口径：设置页落地于 GitPolicySettings（workspace 级 Git 设置面板，spec F-1 修复项）——一行 `text-secondary` 提示含命令与 `Info` 图标；README 开发节同步一行

## 6. 协议层（全部搭既有通道，无新消息通道）

- `MessageContext` 加 `images?: Array<{ path: string; w: number; h: number }>`（workspace 相对路径 + 降采样后尺寸——token 估算免图片解析依赖）
- `sanitizeMessageContext`：images 元素级过滤（path string + w/h 正整数），外层 spread 透传语义保持
- `messages.context_json` 并列存 images——**历史重建唯一数据源**；`parseMessageContext` 形状校验同步（images 可选，缺省=旧消息兼容）
- `ExpandedContext` 加 `images: Array<{ path; mime; base64; w; h }>`：expander 逐个读文件（单图 base64 后 >8MB 或读取失败 → 剔除 + warn + 正文占位 `[图片加载失败: path]`），**永不抛错**契约沿用
- `TaskConfig.context` / steer 载荷 / resume SteerReplayItem 天然携带（同一对象形状，零额外字段）
- 上限：单条消息 ≤6 张（renderer 拦截 + sanitize 双层）；重发窗口内累计同限

## 7. LLM 请求层

- `LLMMessage` 加**可选** `images?: Array<{ mime: string; base64: string; w: number; h: number }>`——既有 69 个纯文本消费点（记忆提取/会话命名/压缩序列化等）零破坏；w/h 供 token 估算消费（§9），provider 映射时忽略
- **OpenAI 平台**（含智谱/通义/豆包/Kimi/Grok/Gemini 兼容端）：images 非空时 content 映射 `[{type:'text'},{type:'image_url',image_url:{url:'data:<mime>;base64,...'}}]`；空时维持 string（字节不变，回归锁保证）
- **Anthropic 平台**：`[{type:'image',source:{type:'base64',media_type,data}},{type:'text',text}]`
- `resolveVisionCapability(provider, model)`（spawn-helpers，与 resolveThinkingConfig 同款）：`provider_models.vision` 优先 → PresetModel.vision → false；产物进 **`AGENT_CONFIG.vision: boolean`**（spawn 快照，运行时单一真相源）
- **非 vision 模型降级**（确定性，不报错）：该 agent 的请求不带 images；本轮正文尾部注入 `[图片已省略：当前模型不支持视觉]`（N 张 N 条，renderTurnBody 同源一次性注入、不落库）

## 8. 能力发现与团队路由

`SessionMemberInfo` 加 `vision` 字段（同源解析，仅 UX 提示用；运行时以 AGENT_CONFIG 快照为准，防换模型竞态）。

**场景 1：全场无 vision**（快速会话单 agent 非视觉 / 团队全员非视觉）
- 发送前：粘贴或选图时 renderer 内联提示「当前 agent 的模型 X 不支持图片，发送时图片将省略」（不阻止发送——历史留缩略图，换模型后近 2 轮仍可追问）
- 运行时兜底：§7 降级注入

**场景 2：leader 非 vision，团队存在 vision 成员**——leader 权威不动，给它决策信息：
- runtime 向 leader 本轮注入系统级文本（不落库）：

  > `[系统提示：用户消息附带 N 张图片（path1、path2…）。你当前模型不支持视觉。团队成员「name」（model）可识别图片——直接 dispatch 任务给它，子任务会自动附上会话近期图片。]`

- **dispatch 自动附图**：`routeDispatch` 构造子 task-config 时，将**会话近 2 轮 images** 合入 context；传输按目标 agent 的 `AGENT_CONFIG.vision` 过滤——vision 子代理附 base64（≤6 张 / 单请求 ≤8MB base64 累计），非 vision 子代理仅传 path 占位（省 IPC 体积）。leader 不需要新原语
  - 2026-09-26 实现口径勘误：非 vision 子代理**传 `images: []`**（fail-safe，不传 base64 也不传 path 占位），与原文「仅传 path 占位」字面不一致——T9 评审裁决为正确取舍：若子代理后端对 path 字段做隐式读取会发生「图片静默丢失」故障，而 `images:[]` 让其场景 1 降级链路接管；review §1-d 与 §3 §8 已记档
- **@ 直答**：@ vision 成员 → 其 runner 正常收到 images（既有路径，天然工作）

**场景 3：agent 怎么知道自己能处理图片**——不需要知道：runtime 知道（AGENT_CONFIG.vision）并在三处行动（自身轮次带图/降级、leader 路由提示、dispatch 附图过滤）。模型零 prompt 改动。

## 9. 会话重建、压缩与预算

- **近 2 轮重发**：`rebuildSessionContext` / turn-reconstructor 构建历史时，最后 2 条 user 消息的 context_json.images 经 expander 恢复 base64 进对应 LLMMessage.images；更早轮次与 resume 重建段同理按窗口判定
- **压缩**：compaction 序列化时 images 一律降 `[图片: path]` 文本占位——压缩后历史天然无图（与 Q1 语义一致）；记忆提取（workspace/global memory）不提取图片
- **断点续跑**：resume 的重建段沿用近 2 轮窗口规则（断点消息本身是窗口内时恢复真图）
- **token 估算**：`estimateImageTokens(w,h) = max(258, ⌈w×h/750⌉)`（对齐 OpenAI tiles 近似）；token-estimate 消费 LLMMessage.images 累加；无尺寸信息按保守 1024/张
  - 2026-09-26 实现口径勘误：「无尺寸信息按保守 1024/张」死代码化——`ImageContextItem.w/h` 类型 `number` 必填 + `sanitizeMessageContext` 正整数过滤双保险，全链强制有尺寸；保守兜底不可达，但保留作防御性默认值（review §3 §9 已记档）

## 10. renderer UI

- **paste/drop 拦截**：RichComposer `onPaste`/`onDrop` 捕获 `clipboardData.files` / DataTransfer 中图片项 → 降采样 → `asset:saveImage` → 插 image pill；纯文本粘贴路径不变
- **image pill**：新 `PillKind='image'`——缩略图（h-6 内联）+ 文件名，Backspace 两段式删除照旧；`composer-segments`：序列化 body 锚点 `[图片: name]` + `context.images`（path 去重保序）；草稿往返（draftToSegments 白名单）同步
  - 2026-09-26 实现口径勘误：composer 内 image pill **无缩略图**——lucide 图标（Image）+ 文件名（h-6 内联 chip）；缩略图渲染在气泡侧（MessageBubble 读 `context_json.images`，见下一条）。T7 已绑定气泡侧缩略图；spec 原文与实现有差，以实现为准（review §3 §10 已记档）
- **能力提示**：输入框上方细提示行（粘贴即显，发送后消失）——「当前 agent 的模型不支持图片，发送时将省略」；团队场景列出可视觉成员名
- **气泡**：MessageBubble 读 context_json.images 渲染缩略图行（内联 max-w-240px、圆角、纯展示无点击行为——YAGNI）
- **上限拦截**：>6 张时第 7 张拒绝 + toast 提示

## 11. 错误处理与降级矩阵

| 故障 | 行为 |
|---|---|
| asset:saveImage 失败（磁盘满/权限） | pill 不插入 + toast 错误，输入不受影响 |
| expander 读图失败 / 超限 | 剔除该图 + warn + 正文 `[图片加载失败: path]` 占位 |
| 非 vision 模型收图 | §7 降级注入，请求不带图 |
| 历史消息图片文件被用户删除 | rebuild 时按读取失败降级（同 expander 规则），气泡缩略图占位（onerror 兜底样式） |
| 旧版本消息（无 images 字段） | 全链路按缺省兼容，零行为变化 |

## 12. 测试计划

| 层 | 用例 |
|---|---|
| provider-presets | vision 标志快照锁（防条目漂移）；新条目规格 |
| spawn-helpers | resolveVisionCapability 三级优先级 |
| llm-provider | 双平台 parts 映射（有图/无图字节不变）；非 vision 剥图 |
| context-expander | 图片读取/失败剔除/超限/路径逃逸拒绝 |
| composer-segments | image pill 序列化（锚点+去重）；草稿往返 |
| session.ipc | sanitize images 元素过滤 |
| rebuild/compaction | 近 2 轮恢复边界（第 3 轮不恢复）；压缩占位 |
| router dispatch | 子代理 vision 过滤（base64 vs path） |
| renderer | paste 拦截 + 降采样 mock、image pill、气泡缩略图、能力提示、6 张上限 |
| 真机 | 粘贴截图 → GLM-4.6v / gpt-5.2 描述内容正确；leader 非 vision 场景路由提示可见 |

## 13. 明确不做（YAGNI）

- lightbox / 图片放大查看器
- 图片生成模型（gpt-image-*、gemini-flash-image）目录条目
- P2P 任务镜像携带图片（spec D7 只读镜像不含 assets）
- 图片编辑/裁剪、EXIF 处理
- qwen3-vl / doubao-vision / pixtral 预设条目（主线已覆盖或规格未核实，§3.2 记录）
- 记忆系统存图（图片不进 workspace/global memory）

## 14. 遗留与开放问题

- **@ 引用图片的气泡显示限制（T10 评审 I-1，2026-09-26 记档）**：`asset:readDataUrl` 白名单仅放行 `.momo/assets/<12hex>.(png|jpg)` 命名产物——`@` 菜单引用的 workspace 内任意路径图片在气泡显示「图片不可用」，但模型侧不受影响（expander 读取不限于 assets 命名）。属本 spec §5 与 §10 的内部口径差；后续专项任务二选一：renderer 中性 chip（无缩略图）或读面扩白名单（须重审读面安全）

- `openai/gpt-oss-120b`（Groq）vision 未核实——默认 false，用户可经模型编辑开关打开
- `glm-5v-turbo` 规格未公布——暂不入目录
- **2026-09-26 P0 修复记录**：glm-5.3-flash 曾因「规格未核实暂不入目录」缺预设条目 → 能力解析 false → 剥图（用户实测暴露）；已按官方文档补录 flash/flashx 两条目。同批发现旧 `vision NOT NULL DEFAULT 0` 把列默认值误当「用户显式关」（聚合商标题行受害）——迁移 046 三态化修正
- 智谱 GLM-V 精确 per-image token 公式未公开——按 §9 通用公式估算，必要时按 usage 实测回修
