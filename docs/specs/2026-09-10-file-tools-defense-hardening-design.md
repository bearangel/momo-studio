# v2.3 — FileTools 防御硬化（apply_patch + Read-before-Edit + edit_file 失败恢复）

**版本**：v2.3.0（计划）
**作者**：Sisyphus（基于 brainstorming 会话产出）
**日期**：2026-09-10
**状态**：设计中 → 待 spec 评审 → writing-plans → 实施

## 1. 背景

v1.5 工具库扩充到 24 个工具 + v2.2 引入 MemoryTools 后，FileTools 暴露三处断裂：

1. **缺结构化 patch 语法**：`edit_file` 只支持精准字符串替换。LLM 想同时改 5 个文件时，必须发 5 个独立 tool call，每个都需精确定位 oldString——对长文件（>500 行）或多文件协同场景下，oldString 命中失败率高、token 消耗大。主流（Codex CLI / Cline / Roo-Cline）均已支持 V4A `apply_patch` 语法（多文件原子操作 + 结构化 patch + 失败可恢复）。
2. **缺 Read-before-Edit 守门**：Claude Code 强制 Edit/Write 前必须 Read 同文件；bash 内的 `cat`/`nl`/`bat`/`head`/`tail`/`sed -n 'X,Yp'`/`grep`/`rg` 单文件无管道也算 Read。Momo 当前 `write_file`/`edit_file` 无任何 Read 守门——LLM 可凭想象写出错误的 file content，产生「我以为我改了但实际没改」的静默失败。
3. **edit_file 失败信息简陋**：当前失败只返回「oldString 不唯一/不存在」一行文字，无原文快照、无锚点行号——LLM 必须再次调 read_file 才能定位错误位置，徒增 1 个 round-trip。

v2.3 系统性补齐 FileTools 防御契约：新增结构化 apply_patch 工具 + Read-before-Edit 守门 + 失败信息增强。

## 2. 目标

- 新增 `apply_patch` 工具：V4A grammar + 自写 PEG parser + streaming 解析 + 多文件原子执行
- `edit_file` / `write_file` 增强 Read-before-Edit 强阻塞（write_file 创建新文件豁免）
- `edit_file` 失败信息增强：原文前 5KB 快照 + 首次不一致行号 + 建议重试路径
- 3 个 builtin agent（coder / pm-agent / requirement-analyst）的 `defaultTools` 加 `apply_patch`
- `ALL_BUILTIN_TOOLS` 常量同步新增 `apply_patch`

## 3. 非目标

- 不实现 `apply_patch` 流式事件推送（`PatchApplyUpdated`）——v2.4 再做，本期单次 tool call 一次性返回
- 不实现 `apply_patch` 与 Read-before-Edit 状态联动（apply_patch 不需 Read 守门，patch 语法本身表达修改意图）
- 不替换 `edit_file`/`write_file`——并存保留，由 LLM/agent 决定何时用哪个
- 不改 `mkdir`/`rm`/`mv`/`exists`/`list_files`——本 spec 不涉及
- 不实现 Lark grammar 库依赖——自写 PEG parser（避免增加运行时依赖）
- 不实现 apply_patch 的 dry-run / preview 模式（仅一次性执行；用户可回滚通过 git）

## 4. 关键决策汇总

| 维度 | 决策 | 理由 |
|---|---|---|
| 范围 | P0 三项打包：apply_patch + Read-before-Edit + edit_file 失败恢复 | 防御契约闭环，1 spec 体量，1 PR 可独立发布 |
| apply_patch 定位 | 新增独立工具（与 edit_file 并存） | 不破坏现有 builtin agent；给 LLM 选择空间；未来可弃用 edit_file |
| V4A grammar | 自写 PEG parser（约 150 行）+ corpus 锁 | 不引 lark 依赖；corpus 测试保证 parser 严格性 |
| 多文件原子性 | 全部成功或全部回滚（执行前快照受影响文件 → 失败时还原） | 与 Codex apply_patch 行为对齐；用户期待 patch 是原子的 |
| ReadTracker 维度 | 按 `streamSessionId`（一 stream 会话一份） | 与 agent 心智模型对齐；会话结束自动清理 |
| 子 agent 隔离 | 子 agent 不继承父 agent 的 read_tracker（fresh-session 对齐） | 与 Memory 子 agent fresh-session 规则一致；通过 `parentStreamSessionId` 判定 |
| write_file 豁免 | 仅「文件不存在」豁免；存在但未 Read → 阻塞 | 创建新文件无需 Read；覆盖/重写已有文件必须先 Read |
| 失败信息增强 | 原文前 5KB + 首次不一致行号 + 建议 read_file | 5KB 远低于 OUTPUT_LIMITS 默认 100KB，不撑爆 LLM 上下文 |
| builtin agent 升级 | 3 个 YAML defaultTools 加 apply_patch（保留 edit_file/write_file） | 让 builtin agent 优先用 apply_patch；保留 fallback 兼容 |

## 5. 架构总览

### 5.1 模块划分

```
electron/src/main/agent/tools/
├── apply-patch-tools.ts       (新增 — V4A grammar + parser + executor)
├── file-tools.ts              (改造 — Read-before-Edit + 失败信息增强)
├── types.ts                   (不变 — ToolModule 接口复用)
├── index.ts                   (改造 — buildToolRegistry 加 ApplyPatchTools)
└── shared/
    ├── read-tracker.ts        (新增 — 维护 streamSession 维度"已读取文件"集合)
    └── edit-recovery.ts       (新增 — 失败错误信息格式化)
```

### 5.2 数据流（一次 tool call）

```
LLM 调用 tool_use(name="apply_patch", input={patch: "*** Add File: foo\n+..."})
  ↓
runtime-entry 拦截：权限 / 审计 / abortSignal
  ↓
executeTool("apply_patch", args, ctx, modules)
  ↓
ApplyPatchTools.execute → executePatch(args, ctx)
  ↓
1. PEG parser 解析 patch 文本 → AST { ops: [{op: 'add'|'update'|'delete', path, hunk}] }
2. 路径校验：每个 path 走 ctx.wsFs.assertInWorkspace
3. 多文件原子：执行前快照所有受影响文件 → 临时目录 backup/
4. 逐 op 执行（顺序：add → update → delete）：
   - add: ctx.wsFs.writeFile(absPath, content)
   - update: 读取文件 → 替换 hunk → 写回
   - delete: ctx.wsFs.unlink(absPath)
5. 成功 → 清理 backup/ → 返回 "已应用 N 个文件"
6. 失败 → 还原 backup/ → 抛错 + 错误信息含 AST + 已应用 ops
```

```
LLM 调用 tool_use(name="edit_file", input={path, oldString, newString})
  ↓
runtime-entry 拦截
  ↓
executeTool("edit_file", args, ctx, modules)
  ↓
FileTools.execute → executeEdit(args, ctx)
  ↓
1. ctx.readTracker.assertRead(sessionId, path)  ← 强阻塞
   - 未读 → 抛错 "文件未读取。请先调用 read_file 读取 X 后再编辑。"
2. 执行 str_replace
3. 失败 → editRecovery.format(...) → 抛错含原文 5KB + 行号 + 建议
```

```
LLM 调用 tool_use(name="read_file", input={path})
  ↓
runtime-entry 拦截
  ↓
executeTool("read_file", args, ctx, modules)
  ↓
FileTools.execute → executeRead(args, ctx)
  ↓
1. 读取文件 → 返回内容
2. ctx.readTracker.add(sessionId, path)  ← 标记已读
```

## 6. 详细设计

### 6.1 apply_patch 工具

**ToolModule** 实现，新增文件 `apply-patch-tools.ts`：

```typescript
// electron/src/main/agent/tools/apply-patch-tools.ts
export class ApplyPatchTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'apply_patch',
        description: '应用结构化 V4A patch 语法...（含 add/update/delete 三头）',
        inputSchema: {
          type: 'object',
          properties: {
            patch: { type: 'string', description: 'V4A patch 文本' },
          },
          required: ['patch'],
        },
      },
    ];
  }
  handles(name: string): boolean { return name === 'apply_patch'; }
  async execute(name, args, ctx) { return executePatch(args, ctx); }
}
```

**V4A grammar 子集**（自写 PEG，约 150 行）：

```peg
patch      = (op)+
op         = addOp | updateOp | deleteOp
addOp      = "*** Add File:" path newline content
updateOp   = "*** Update File:" path newline hunk
deleteOp   = "*** Delete File:" path newline
path       = <非空字符串，trim 后>
content    = <每行前缀 "+" 的行集合>
hunk       = "@@" anchor newline (change)*
anchor     = <唯一锚点字符串>
change     = (" " line) | ("-" old) | ("+" new)
```

**多文件原子性**：

```typescript
async function executePatch(args, ctx): Promise<string> {
  const ast = parse(args.patch);
  // 路径校验（每个 op 路径走 assertInWorkspace）
  for (const op of ast.ops) ctx.wsFs.assertInWorkspace(op.path);

  // 快照：受影响文件复制到 Electron userData/apply-patch-tmp/<uuid>/
  const backupDir = path.join(app.getPath('userData'), 'apply-patch-tmp', randomUUID());
  for (const op of ast.ops) {
    if (op.kind === 'update' || op.kind === 'delete') {
      await copyToBackup(op.path, backupDir);
    }
  }

  try {
    let applied = 0;
    for (const op of ast.ops) {
      await applyOp(op, ctx);
      applied++;
    }
    await fs.rm(backupDir, { recursive: true });
    return `已应用 ${applied} 个文件`;
  } catch (err) {
    await restoreFromBackup(backupDir, ctx);
    await fs.rm(backupDir, { recursive: true });
    throw new Error(`apply_patch 失败，已回滚: ${err.message}`);
  }
}

async function applyOp(op: PatchOp, ctx: ToolContext): Promise<void> {
  switch (op.kind) {
    case 'add':
      await ctx.wsFs.writeFile(op.path, op.content ?? '');
      break;
    case 'update':
      const content = (await ctx.wsFs.readFile(op.path)).toString('utf-8');
      const newContent = applyHunk(content, op.hunk);
      await ctx.wsFs.writeFile(op.path, newContent);
      break;
    case 'delete':
      // 通过 wsFs.assertInWorkspace 已校验，物理删除用 raw fs
      const absPath = path.resolve(ctx.workspaceDir, op.path);
      await fs.promises.unlink(absPath);
      break;
  }
}
```

**关键约束**：
- 路径走 `wsFs.assertInWorkspace`（与 FileTools 一致）
- 失败回滚后抛出错误信息含 AST + 已应用 op 数（LLM 可针对性重试）
- 不写入 `tool_calls` 审计表的特殊字段——按现有 `audited()` 包装自动记录

### 6.2 ReadTracker

新增 `electron/src/main/agent/tools/shared/read-tracker.ts`：

```typescript
export class ReadTracker {
  /** streamSessionId → Set<path> */
  private sessionReads = new Map<string, Set<string>>();

  add(streamSessionId: string, path: string): void {
    if (!this.sessionReads.has(streamSessionId)) {
      this.sessionReads.set(streamSessionId, new Set());
    }
    this.sessionReads.get(streamSessionId)!.add(path);
  }

  has(streamSessionId: string, path: string): boolean {
    return this.sessionReads.get(streamSessionId)?.has(path ?? false) ?? false;
  }

  /** 子 agent fresh-session：不传 parentStreamSessionId 即空集合 */
  assertRead(streamSessionId: string, parentStreamSessionId: string | undefined, path: string): void {
    if (parentStreamSessionId) {
      // 子 agent 永远 fresh
      throw new Error(`文件未读取。请先调用 read_file 读取 ${path} 后再编辑。`);
    }
    if (!this.has(streamSessionId, path)) {
      throw new Error(`文件未读取。请先调用 read_file 读取 ${path} 后再编辑。`);
    }
  }

  /** 会话结束清理 */
  clear(streamSessionId: string): void {
    this.sessionReads.delete(streamSessionId);
  }
}
```

**ToolContext 扩展**：

```typescript
export interface ToolContext {
  // ... 现有字段 ...
  /** v2.3 Read-before-Edit：维护 streamSession 维度已读文件集合 */
  readTracker?: ReadTracker;
}
```

**注册中心改造**：`runtime-entry` 组装 `ToolContext` 时创建 `ReadTracker` 单例（按进程生命周期），注入到所有 `ToolModule`。

**子 agent 隔离**：子 agent 的 `ToolContext.parentStreamSessionId` 非空 → `ReadTracker.assertRead` 永远抛错（fresh-session 对齐）。这强制子 agent 先 Read 再 Edit，与父 agent 路径无关。

### 6.3 write_file / edit_file 增强

**write_file 路径**（`file-tools.ts`）：

```typescript
async function executeWrite(args, ctx): Promise<string> {
  const path = parseStringArg(args.path, 'path');
  ctx.wsFs.assertInWorkspace(path);

  // v2.3 Read-before-Edit（仅对已存在文件生效；新文件豁免）
  const exists = fs.existsSync(path.resolve(ctx.workspaceDir, path));
  if (exists) {
    ctx.readTracker?.assertRead(ctx.streamSessionId, ctx.parentStreamSessionId, path);
  }

  // 执行写入
  await ctx.wsFs.writeFile(path, args.content);

  // 标记已读（让后续 edit_file 通过 Read 守门）
  ctx.readTracker?.add(ctx.streamSessionId, path);

  return `已写入 ${path}`;
}
```

**edit_file 路径**（`file-tools.ts`）：

```typescript
async function executeEdit(args, ctx): Promise<string> {
  const path = parseStringArg(args.path, 'path');
  const oldString = parseStringArg(args.oldString, 'oldString');
  const newString = parseStringArg(args.newString, 'newString');
  ctx.wsFs.assertInWorkspace(path);

  // v2.3 Read-before-Edit
  ctx.readTracker?.assertRead(ctx.streamSessionId, ctx.parentStreamSessionId, path);

  // 读取文件内容（已通过 sandbox 校验）
  const content = (await ctx.wsFs.readFile(path)).toString('utf-8');

  // 检查 oldString 唯一性
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw formatEditError('not_found', path, oldString, content);
  }
  if (occurrences > 1) {
    throw formatEditError('not_unique', path, oldString, content, occurrences);
  }

  await ctx.wsFs.writeFile(path, content.replace(oldString, newString), 'utf-8');
  return `已编辑 ${path}`;
}
```

### 6.4 edit_file 失败信息增强

新增 `electron/src/main/agent/tools/shared/edit-recovery.ts`：

```typescript
export function formatEditError(
  kind: 'not_found' | 'not_unique',
  path: string,
  oldString: string,
  fileContent: string,
  occurrences?: number,
): Error {
  const head = fileContent.slice(0, 5 * 1024); // 5KB
  const line = findFirstMismatchLine(fileContent, oldString);
  const hint = occurrences && occurrences > 1
    ? `oldString 在文件中出现 ${occurrences} 次，请添加更多上下文使其唯一。`
    : 'oldString 未在文件中找到。请重新调用 read_file 读取最新内容后重试。';
  return new Error(`edit_file 失败 (${kind}): ${hint}\n` +
    `文件: ${path}\n` +
    `首次不一致行号: ${line ?? 'N/A'}\n` +
    `---\n` +
    `原文件前 5KB 快照:\n${head}\n` +
    `---\n` +
    `建议: 调用 read_file 重新读取 ${path} 后重试`);
}

function findFirstMismatchLine(content: string, oldString: string): number | null {
  const lines = content.split('\n');
  // 简化：找 oldString 第一行的最早出现位置
  const oldFirstLine = oldString.split('\n')[0] ?? '';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(oldFirstLine)) return i + 1;
  }
  return null;
}
```

### 6.5 builtin agent 升级

3 个 builtin YAML（`coder.yaml` / `pm-agent.yaml` / `requirement-analyst.yaml`）的 `defaultTools` 列表在 `edit_file` 后插入：

```yaml
    - kind: builtin
      ref: edit_file
    - kind: builtin
      ref: apply_patch  # ← 新增
```

**Migration v32**：同步 builtin YAML → DB（与 v1.6 Migration v16 一致机制），保证升级后 builtin agent 的 defaultTools 包含 `apply_patch`。

**`ALL_BUILTIN_TOOLS` 常量同步**（`electron/src/main/agent/tools/catalog.ts`）：

```typescript
export const ALL_BUILTIN_TOOLS = [
  // 文件（8） + apply_patch
  'read_file', 'write_file', 'list_files', 'edit_file', 'apply_patch',
  'mkdir', 'rm', 'mv', 'exists',
  // ...
] as const;
```

## 7. 数据迁移

**Migration v32**（新建文件 `electron/src/main/storage/migrations/032_v2.3_builtin_apply_patch.ts`）：

```sql
-- builtin agent default_tools 扩展：写入 apply_patch
UPDATE agent_definitions
SET default_tools_json = json_insert(default_tools_json, '$[#]', 'apply_patch')
WHERE source = 'builtin' AND NOT EXISTS (
  SELECT 1 FROM json_each(default_tools_json) WHERE json_each.value = 'apply_patch'
);
```

**回滚**：v32 DOWN migration 不主动清理 apply_patch（仅新增，不删除）。

## 8. 测试与回归锁

### 8.1 单元测试

| 测试范围 | 文件 | 用例数 |
|---|---|---|
| V4A grammar parser | `electron/tests/agent/tools/apply-patch-grammar.test.ts` | 30+（语法正确 / 部分错误 / 多文件混合 / 边界） |
| apply_patch executor | `electron/tests/agent/tools/apply-patch-executor.test.ts` | 20+（多文件原子性 / 失败回滚 / 路径越界 / 已存在文件 / 不存在文件） |
| ReadTracker | `electron/tests/agent/tools/read-tracker.test.ts` | 10+（add/has/clear/子 agent 隔离 / 跨 session 隔离） |
| edit_file Read 守门 | `electron/tests/agent/tools/file-edit-read-gate.test.ts` | 8+（未读阻塞 / 已读通过 / 子 agent 永远 fresh / write_file 创建豁免） |
| write_file 豁免 | `electron/tests/agent/tools/file-write-read-gate.test.ts` | 6+（新文件豁免 / 已有文件阻塞 / 写入后标记已读） |
| edit_recovery 失败信息 | `electron/tests/agent/tools/edit-recovery.test.ts` | 10+（not_found / not_unique / 5KB 截断 / 行号定位 / 建议文案） |

### 8.2 集成测试

| 测试范围 | 文件 | 用例数 |
|---|---|---|
| apply_patch + WorkspaceFS | `electron/tests/agent/tools/apply-patch-sandbox.test.ts` | 5+（路径越界 / 符号链接逃逸） |
| 工具注册中心 | `electron/tests/agent/tools/tools-catalog-v2.3.test.ts` | 3+（ALL_BUILTIN_TOOLS 同步 / ApplyPatchTools 注入 / SAFE_MINIMUM_TOOLS 不含 apply_patch） |
| builtin agent 同步 | `electron/tests/storage/migration-v32.test.ts` | 3+（3 builtin agent defaultTools 含 apply_patch） |

### 8.3 回归锁

- `tests/agent/tools-catalog.test.ts` 已有的「ALL_BUILTIN_TOOLS 与各模块声明一致」断言自动扩展覆盖 `apply_patch`
- `tests/agent/types-extended.test.ts` 现有的 ToolContext schema 校验覆盖 `readTracker?: ReadTracker`
- `momo-test-rules`：所有 mock 必须仿真真实运行时语义（ReadTracker 单例、parentStreamSessionId 注入、WorkspaceFS.assertInWorkspace 调用链）

## 9. 迁移与发布

### 9.1 变更范围

- **新增文件**（3 个）：`apply-patch-tools.ts`、`shared/read-tracker.ts`、`shared/edit-recovery.ts`
- **修改文件**（6 个）：`tools/index.ts`、`tools/types.ts`、`tools/file-tools.ts`、`tools/catalog.ts`、`electron/resources/agents/*.yaml` (3 个)、`electron/src/main/storage/migrations/032_v2.3_builtin_apply_patch.ts`
- **测试文件**（6 个新增）：见 §8

### 9.2 发布策略

- 单 spec → 单 plan → 单 PR
- changelog：v2.3.0 条目
- docs：`docs/dev/rules/engineering.md` 增 P0 Read-before-Edit 规则说明
- 不破坏兼容：v2.2.1 用户的 builtin agent 在 v2.3.0 升级后自动获 apply_patch 能力

### 9.3 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| V4A parser 不严谨致 LLM 误用 | 中 | 中 | 30+ corpus 测试 + 显式语法错误信息 |
| Read-before-Edit 阻塞现有合法流程 | 中 | 高 | write_file 创建新文件豁免；测试覆盖各种边界 |
| 多文件原子性失败致 workspace 损坏 | 低 | 高 | 备份临时目录 + 失败自动还原；快照放在 Electron `userData/apply-patch-tmp/`（workspace 外） |
| 子 agent fresh-session 致子 agent 重复 Read | 中 | 低 | 与 Memory fresh-session 规则一致；用户预期子 agent 独立工作 |

## 10. 边界决策汇总

| 决策点 | 选择 | 理由 |
|---|---|---|
| V4A grammar 范围 | 仅 add/update/delete 三头；不支持 `*** Move to:` 改名操作 | 与 Codex/Cline 子集对齐；改名 = delete + add 二段操作可达同样效果 |
| apply_patch 输出格式 | 成功 → `已应用 N 个文件`（单段） | 简洁；细粒度统计可在 tool_calls 审计表查（input/output JSON） |
| ReadTracker 持久化 | 不持久化，重启即失 | 与 streamSession 生命周期对齐；磁盘持久化 = session 持久化范畴，留 v2.4 会话持久化 spec 一并处理 |
| 子 agent 阻断策略 | 直接抛错（与 Memory fresh-session 规则一致） | 不允许子 agent 继承父 agent 已读状态；强制 fresh-session |
| apply_patch 与 Read 守门 | apply_patch 不触发 Read 守门 | patch 语法本身已表达修改意图；强加 Read 会让多文件原子操作变冗余 |
| 备份目录位置 | workspace 外的 `state.apply-patch-tmp/` | 不污染 workspace；runtime-entry 启动时清理过期 tmp |

## 11. 参考

- 调研产出：与 Claude Code / Cursor / Codex CLI / Cline / Copilot 的对比报告（2026-09-10 会话）
- 工程规则：`docs/dev/rules/engineering.md`（momo-debug-rules / momo-test-rules / momo-boundary-rules）
- v1.5 工具库扩充 spec：`docs/specs/2026-08-04-v1.5-builtin-tool-library-design.md`
- v1.6 能力配置 spec：`docs/specs/2026-08-11-v1.6-capability-config-design.md`
- v2.2 记忆系统 spec：`docs/specs/2026-09-03-v2.2-agent-memory-design.md`