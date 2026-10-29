# 资源库「库 / 商店」分离设计（library-store-split）

- **日期**：2026-10-29
- **状态**：待评审（Momus）
- **范围**：studio 单侧；**协议零改、hub 零改**
- **预览**：`.omo/previews/library-store-split.html`（P1 门禁已过，用户 2026-10-29 确认「没有问题」）
- **消费面矩阵**：`.omo/feature-matrices/2026-10-29-library-store-split.md`（14 点全裁定，门禁 8 问全过）
- **背景讨论**：发布者本机「同物两卡」疑惑（本地 custom ↔ hub 目录副本）→ 裁定「库=本地实体 / 商店=远端目录」心智分离，UI 层消解；hub 侧归属权威（slug 领地制）与「已发布」徽标**另立独立票**（见 §8 非目标）

## 1. 问题与目标

**问题**：资源库四类型页混排本地实体与远端目录未装条目（hub/marketplace/Smithery 以来源筛选形式混入），导致：① 发布者本机同物两卡；② 「名义已安装单态、实际混目录」心智分裂；③ 三条提示横幅挂在筛选态上散乱。

**目标**：
1. 库页一条卡 = 一个本地实体（builtin / custom / 已装远端出处条目），装了才出现
2. 远端获取统一收进各类型页「＋」菜单（AddMenu），弹出该类型该源的资源列表对话框完成浏览+安装
3. 提示横幅（未接入/降级）迁入弹窗内呈现

## 2. 设计

### 2.1 库页收窄（四类型页同构）

- 来源筛选下拉只剩三档：**全部 / 系统预置 / 自定义**（SOURCE_OPTIONS 删 hub 档；hub 计数逻辑删；marketplace/smithery 已装条目计入「全部」无专属档）
- 工具栏删「外部市场」按钮；`ExternalMarketplacePopover` 组件整体退场
- 库页三条横幅删除：hub 未接入灰条、hub 降级黄条、市场目录降级黄条（语义迁弹窗 §2.3）
- 已装卡的来源徽标（SourceBadge）、hub 更新角标（hubUpdates）**不变**

### 2.2 AddMenu 新增远端获取组

各类型页「＋」菜单在本地项之后加分隔线 + 远端组（**顺序为预览定值**）：

| 页 | 本地项（不变） | 远端组（新增） |
|---|---|---|
| agent | 新建智能体… / 导入 YAML 文件… | **从 momo-hub 获取…** / 从网络市场获取… |
| mcp | 快速创建… / 导入 JSON… / 导入 DXT/MCPB 包 | **从 momo-hub 获取…** / 从网络市场获取… / 从 Smithery 获取… |
| skill | 导入 zip 包… / 新建 SKILL.md… / 从 Git 仓库导入… | **从 momo-hub 获取…** / 从网络市场获取… |
| plugin | 安装插件 zip… / 注册开发目录… | **从 momo-hub 获取…** |

菜单项带 lucide 图标 + 副文案（预览定值）。

### 2.3 获取弹窗（新组件，三源同构）

**定值**（预览合同条款，落码逐项核对）：
- 宽 620px / max-height 560px / 圆角 12px；标题「从 {源名} 获取 · {类型名}」+ 关闭钮
- 搜索框（名称/描述/slug）；hub 与 marketplace 目录快照客户端过滤，Smithery 走服务端分页搜索
- 列表行：图标 / 名称 / 最新版 / 描述（单行截断）/ 元信息（作者 · 版本数 · 本地版本）；行内**四态**：
  1. **安装**（未装；主按钮）
  2. **更新**（同 type+slug 已装且远端 semver 更高；描边按钮 + 「✓ 已装 v{本地}」）
  3. **已装最新**（灰显「✓ 已装 v{N} · 最新」，无按钮）
  4. **安装中**（底部进度行 + 百分比；hub/marketplace 复用安装链既有进度语义）
- 底部脚注：连接态小字（hub：`已连接 {nodeName} · 目录 {N} 项 · 修订 {revision}`；marketplace：`官方内置目录 · {N} 项`；smithery：`smithery.ai · 社区目录 · 远程直连注册`）+ 刷新入口（hub）
- **特殊态**（取代原库页横幅）：
  - hub 未接入：空态卡（CloudOff 图标 + 「未接入 momo-hub」+ 「去设置接入」主按钮）
  - hub 降级：warning tint 空态卡 + 「重试」按钮（回落最近快照语义保留）
  - smithery hosted 未部署条目：行内灰显「hosted 未部署 · 不可装」

### 2.4 IPC 契约变更

- **`resource:list` 默认语义收窄**：只返回本地实体（builtin + custom + 已装远端出处条目）。依据矩阵 #8/#9：全部非库页消费方（候选列表×3、查重×3）本就客户端过滤 installed，收窄无损且更准。ResourceFilter 形状变更走 `renderer/src/ipc/types.d.ts` + electron 侧镜像同步 typecheck（boundary 纪律）
- **弹窗远端浏览通道**：复用/扩展 `resource:registryProviders` + `resource:registryList`（既有网络注册表通道）承载三源列表；hub 目录消费既有 hub catalog source（load/loadFresh + 事件合并缓存，零新拉取逻辑）；Smithery 分页搜索沿用 provider `list(type, query, page)`
- **安装链零改**：弹窗安装/更新复用 `resource:install` 各源分支（含 hub 逐版本 X-Checksum-Sha256 pinned 下载）；装完落库页（installNotice 机制）

## 3. 退场清单

| 退场物 | 替代 |
|---|---|
| SOURCE_OPTIONS hub 档 + hub 计数 | 弹窗（目录浏览职能） |
| ExternalMarketplacePopover 组件 | AddMenu 真实菜单项 |
| 库页三横幅（hub 未接入/hub 降级/市场降级） | 弹窗特殊态 |
| ResourceCard/ResourceDetail 的未装 install 分支触发面 | 分支代码保留休眠（已装卡渲染路径不变；弹窗行组件独立，不复用卡） |

## 4. 测试计划

- **单测（renderer 贴源）**：FetchDialog 组件（三源 × 四态 × 特殊态矩阵）；TypePageShell 收窄后筛选/计数；resource.store 收窄后 load；AddMenu 项顺序锁（hub 置顶）
- **单测（electron）**：listResources 收窄语义（installed/builtin/custom 恒在、未装远端不在）；registryList 三源通道；既有安装链回归零改
- **回归锁**：候选列表三处（CapabilityTabs/AgentCreateWizard/MentionInput）仍仅已装；查重三处语义
- **e2e**：hub 弹窗安装链（mock hub 模式，沿 hub-distribution 惯例）——库页纯本地断言 + 弹窗四态断言
- **UI 预览定值对照**：落码后按预览合同条款逐项核（P1 事后验收纪律）

## 5. 验收标准

1. 四类型页库网格零未装远端条目；筛选三档正确计数
2. 「＋」菜单远端组四页顺序正确（hub 永远置顶）
3. hub 弹窗：未接入引导 / 降级重试 / 安装 / 更新 / 已装最新 / 安装中 六路可达
4. 已装资源卡徽标 + 更新角标 + 详情 + 发布入口全部不变（存量兼容）
5. 候选列表与查重回归全绿
6. 明暗双主题截图对照预览通过

## 6. 风险与边界

- `resource:list` 语义收窄是**消费方面最广的单点**——矩阵 14 点已全裁定，实施时若 grep 出新消费方须回矩阵补行（W3 纪律）
- Smithery 服务端分页在弹窗内的加载更多交互：首版简单做（搜索词变更即重查首页 + 滚动加载更多），不过度设计
- 弹窗不解决「远端同名资源身份」问题（归属票范围）

## 7. 实施分期（单期，不拆）

一期完成：electron 通道收窄 + registryList 扩展 → renderer store/TypePageShell/AddMenu/FetchDialog → 测试对齐 → e2e。预计一个 PR（分支 `feat/library-store-split`）。

## 8. 明确不做（非目标，另立票）

1. **「已发布」徽标**：依赖 hub 目录条目归属判定，归归属票
2. **hub 资源归属权威（slug 领地制 / owner_node_id / 403/409 / 自救路径）**：独立 hub 侧票（含发布徽标、unpublish 治理重评）
3. 弹窗内 README 大视图 / 评论等商店增强
