# 会话输入框交互精简（v2.11.1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/specs/2026-09-17-composer-ux-refine-design.md`——中文过滤修复、`@` 统一菜单（移除 `@/`）、Kimi 式框内 chips + 📎。

**Architecture:** 全部改动收敛在 renderer 交互层（`MentionInput.tsx` / `InputToolbar.tsx` + 贴源测试 + 1 个 e2e），主进程 / IPC / 落库 / context 展开零改动。三触发正则放宽在前（Task 1），`@` 统一菜单依赖放宽后的正则（Task 2），容器视觉重构独立可验收（Task 3），e2e 与账本收尾（Task 4）。

**Tech Stack:** React 18 + TypeScript strict + Tailwind 语义 token（`docs/dev/design-system.md`）+ Vitest + @testing-library/react + Playwright。

## Global Constraints

- **TypeScript strict**：禁 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`
- **UI 设计系统**：只用语义 token（`bg-surface-*` / `border-subtle` / `text-secondary` 等），禁标准 Tailwind 色阶与 inline 硬编码色；图标 lucide-react 16px / stroke 1.75
- **注释全部中文**；Conventional Commits（`feat:` / `test:` / `docs:`）
- **测试位置**：renderer 贴源 colocated（`MentionInput.test.tsx` 与组件同目录）；根 `tests/e2e/` 仅 Playwright
- **Node 20**（容器内先 `nvm use 20`）；pnpm 用 `npx pnpm@9.0.0`
- **主进程零改动**：不碰 `electron/src/**`（e2e ABI 重建步骤除外，不动源码）
- 运行单测命令：`cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`

---

### Task 1: 触发正则放宽（`/`、`@`、`#` 中文过滤）

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx:225-262`（detectTrigger）、`:292-315`（insertMention）
- Test: `renderer/src/components/im/MentionInput.test.tsx`（新增 describe）

**Interfaces:**
- Consumes: 现有 `detectTrigger` / `insertMention` 结构（不变，只换正则）
- Produces: 三触发捕获字符集放宽——`@` 分支 `[^\s#]*` **含 `/`**（Task 2 统一菜单的前置条件）；`insertMention` 替换正则同步，Task 2 的 `selectFile` 将直接复用它插 `@路径`

- [ ] **Step 1: 写失败测试**（追加到 `MentionInput.test.tsx` 末尾，`@中文名` 用例用 `makeMember`，`#中文` 用 `makeTask`，`/代码` 用 `mockApi.resource.list`——三 fixture 均已存在）

```tsx
// === v2.11.1 F1：触发正则放宽（中文过滤）——旧字符集 [A-Za-z0-9-] 不含中文，
// 敲中文名菜单即关（预置技能名恰是中文）===
describe('MentionInput 触发正则放宽（v2.11.1 F1：中文过滤）', () => {
  it('/代码 → 命令菜单技能组按中文名过滤（含中文名技能命中、其它排除）', async () => {
    mockApi.resource.list.mockResolvedValue([
      makeSkillResource({ slug: 'code-review', name: '代码审查' }),
      makeSkillResource({ slug: 'write-tests', name: '写测试' }),
    ]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/代码' } });
    await waitFor(() => expect(screen.getByText('代码审查')).toBeTruthy());
    expect(screen.queryByText('写测试')).toBeNull();
    // 命令组不被中文 query 误杀：compact 不含「代码」，整组不渲染即可（断言其不存在）
    expect(screen.queryByText('/compact')).toBeNull();
  });

  it('@中文名 → agent 菜单按中文 agentName 过滤', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'i-1', agentName: '代码助手' }),
      makeMember({ instanceId: 'i-2', agentName: 'writer' }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@代码' } });
    await waitFor(() => expect(screen.getByText('代码助手')).toBeTruthy());
    expect(screen.queryByText('writer')).toBeNull();
  });

  it('#中文 → 任务菜单按中文标题过滤', async () => {
    taskState.tasks = [
      makeTask({ id: 'T-1', title: '修复登录' }),
      makeTask({ id: 'T-2', title: '写文档' }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '#登录' } });
    await waitFor(() => expect(screen.getByText(/修复登录/)).toBeTruthy());
    expect(screen.queryByText(/写文档/)).toBeNull();
  });

  it('语义保持：句中 / 不触发命令菜单、// 转义不触发、正文后 @ 不弹成员菜单', () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '看下 src/文件' } });
    expect(screen.queryByText('命令')).toBeNull();
    fireEvent.change(ta, { target: { value: '//' } });
    expect(screen.queryByText('命令')).toBeNull();
    fireEvent.change(ta, { target: { value: '邮箱a@b.com不发菜单' } });
    expect(screen.queryByText('选择要 @ 的 agent')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx -t "中文过滤"`
Expected: 前三个 FAIL（菜单不渲染——中文输入即刻关菜单），第四个 PASS（现状语义已对）

- [ ] **Step 3: 最小实现**——`MentionInput.tsx` 三正则 + `insertMention` 替换正则（注释同步更新；**fileMatch 分支本次原样保留**，短路顺序不变）

```ts
// detectTrigger 内（注释段落「字符集 v2.11.1 放宽为非空白——中文名（技能/agent/
// 任务标题）直接过滤；保留：命令整串锚定 + '//' 转义（'/' 不在字符集）+ 句中
// 不触发 + @/# 互斥」）：
const cmdMatch = before.match(/^\/([^\s/]*)$/);        // 原 [A-Za-z0-9-]*
// fileMatch 分支保持原样（Task 2 移除）
const atMatch = before.match(/(?:^|\s)@([^\s#]*)$/);   // 原 [A-Za-z0-9-]*；含 '/'（Task 2 前置）
const taskMatch = before.match(/(?:^|\s)#([^\s@]*)$/); // 原 [A-Za-z0-9-]*

// insertMention 内替换正则同步放宽（覆盖中文与 '@路径局部'）：
before.replace(
  /(?:^|\s)(@[^\s#]*$|#[^\s@]*$|\/[^\s/]*$)/,
  (match, partial: string) => match.replace(partial, marker),
) + ' ' + after;
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`
Expected: 全文件 PASS（含既有 @/#/发送/草稿等回归用例）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/MentionInput.test.tsx
git commit -m "feat: 输入框三触发正则放宽为非空白字符集（/、@、# 中文过滤）"
```

---

### Task 2: `@` 统一菜单 + 空查询默认列表 + 📎 直开菜单

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx`（删 `fileMode`/`fileQuery` 双轨态；文件搜索 effect 重写；detectTrigger 删 fileMatch 分支；`selectFile` 收敛为 `insertMention` + 登记；📎 效果重写；@ 菜单两块合一）
- Test: `renderer/src/components/im/MentionInput.test.tsx`（重写 `@/` describe 块）

**Interfaces:**
- Consumes: Task 1 的 `insertMention` 放宽正则（`@[^\s#]*$` 覆盖 `@src/pack` 局部）
- Produces: `@` 单触发统一菜单（agent 组 + 文件组同浮层）；正文文件标记 `@{path}`（无 `/` 前缀）；空查询文件组默认列表 = `ipc.file.list(workspaceId, '.')` 过滤文件截 8 条；`pendingFiles` / `pendingSkills` / 发送载荷 / 失败恢复 / 会话切换清空等既有契约**全部不变**（下游 Task 3 布局、e2e 依赖）

- [ ] **Step 1: 重写失败测试**——把现有 `describe('MentionInput @ 菜单文件分组（@/ 路径引用，Task 8）', ...)` 整块替换为：

```tsx
// === v2.11.1 F2：@ 统一菜单（移除 @/ 独立语法，opencode 式）===
// 契约：@ 触发同一浮层 agent 组 + 文件组，同 query 双源；选文件插 @路径（与
// agent 同形）；空 query 文件组显示根目录默认列表（file.list，不发 searchNames）；
// 📎 直开菜单。mockApi.file 需新增 list mock（resetState 同步重置）。
describe('MentionInput @ 统一菜单（v2.11.1 F2）', () => {
  it('输入 @ → agent 组与文件组同浮层渲染（双源同 query）', async () => {
    sessionState.members = [makeMember({ instanceId: 'i-1', agentName: 'coder' })];
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'coder-notes.md', isDirectory: false },
      { path: 'src/', isDirectory: true },
    ]);
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@coder' } });
    await waitFor(() => expect(screen.getByText('选择要 @ 的 agent')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('coder-notes.md')).toBeTruthy());
    expect(screen.queryByText('src/')).toBeNull(); // 目录命中被过滤
  });

  it('选择文件插入 @路径 标记（无 / 前缀，尾随空格）并登记可移除 chip', async () => {
    mockApi.file.searchNames.mockResolvedValue([{ path: 'package.json', isDirectory: false }]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@pack' } });
    const item = await screen.findByText('package.json');
    fireEvent.click(item);
    expect(ta.value).toBe('@package.json ');
    fireEvent.click(screen.getByLabelText('移除文件 package.json'));
    expect(screen.queryByLabelText('移除文件 package.json')).toBeNull();
  });

  it('空 query → 根目录默认列表（file.list，不发 searchNames；仅文件截 8 条）', async () => {
    mockApi.file.list.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.ts`, isDirectory: false, size: 1 })),
      { name: 'src', isDirectory: true, size: 0 },
    ]);
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@' } });
    await waitFor(() => expect(screen.getByText('f7.ts')).toBeTruthy());
    expect(screen.queryByText('f8.ts')).toBeNull(); // 截 8（FILE_MENU_LIMIT）
    expect(screen.queryByText('src')).toBeNull();
    expect(mockApi.file.searchNames).not.toHaveBeenCalled();
  });

  it('📎 点击直开菜单：追加 @（空格防粘连）+ 默认列表可见', async () => {
    sessionState.fileTriggerTick = 1;
    mockApi.file.list.mockResolvedValue([{ name: 'README.md', isDirectory: false, size: 1 }]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('@'));
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
  });

  it('searchNames 失败 → 文件组静默不渲染且不崩（错误路径）', async () => {
    mockApi.file.searchNames.mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@zzz' } });
    await waitFor(() => expect(mockApi.file.searchNames).toHaveBeenCalled());
    // 无菜单渲染（agent 组也空）、输入框仍在
    expect(screen.queryByText('引用文件')).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('发送失败恢复文件 chips 与正文（@路径 标记形态）', async () => {
    sessionState.sendMessage.mockRejectedValue(new Error('net'));
    mockApi.file.searchNames.mockResolvedValue([{ path: 'a.ts', isDirectory: false }]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@a' } });
    fireEvent.click(await screen.findByText('a.ts'));
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(ta.value).toBe('@a.ts '));
    expect(screen.getByLabelText('移除文件 a.ts')).toBeTruthy();
  });
});
```

同时在 `mockApi.file` 增加 `list: vi.fn().mockResolvedValue([])`，`resetState()` 内追加：

```ts
mockApi.file.list.mockClear();
mockApi.file.list.mockResolvedValue([]);
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx -t "统一菜单"`
Expected: 全部 FAIL（`@pack` 不触发文件搜索——fileMode 双轨已删？尚未删，此刻红因旧逻辑 `@` 不带 `/` 不搜文件 + `list` mock 未消费）

- [ ] **Step 3: 实现**——`MentionInput.tsx`：

1. 删 state：`fileMode` / `fileQuery` 两行及其注释；全局移除所有 `setFileMode(...)` 调用（会话切换 effect / detectTrigger / handleKeyDown / selectSkill / handleSend）。
2. 文件搜索 effect 整体替换（依赖 `menuType`/`query`/`workspaceId`；seqRef 守卫覆盖两路径）：

```ts
// @ 统一菜单文件组（v2.11.1 F2）：query 双源之一。空 query → file.list('.') 根目录
// 默认列表（仅文件截 FILE_MENU_LIMIT；主进程 searchNames 语义不动，FileTree 零影响）；
// 非空 → debounce 200ms searchNames（FileTree 同形态）。seqRef 竞态守卫覆盖两路径
// （默认列表与搜索结果可交错返回）。
useEffect(() => {
  if (menuType !== 'agent') {
    fileSearchSeqRef.current++;
    return;
  }
  if (!workspaceId) return;
  const trimmed = query.trim();
  if (trimmed === '') {
    const seq = ++fileSearchSeqRef.current;
    void ipc.file
      .list(workspaceId, '.')
      .then((entries) => {
        if (fileSearchSeqRef.current !== seq) return;
        setFileHits(
          entries
            .filter((e) => !e.isDirectory)
            .slice(0, FILE_MENU_LIMIT)
            .map((e) => ({ path: e.name, isDirectory: false })),
        );
      })
      .catch(() => {
        if (fileSearchSeqRef.current !== seq) return;
        setFileHits((prev) => (prev.length > 0 ? [] : prev));
      });
    return;
  }
  const timer = setTimeout(() => {
    const seq = ++fileSearchSeqRef.current;
    ipc.file
      .searchNames(workspaceId, trimmed)
      .then((hits) => {
        if (fileSearchSeqRef.current !== seq) return;
        setFileHits(hits.filter((h) => !h.isDirectory).slice(0, FILE_MENU_LIMIT));
      })
      .catch(() => {
        if (fileSearchSeqRef.current !== seq) return;
        setFileHits((prev) => (prev.length > 0 ? [] : prev));
      });
  }, FILE_SEARCH_DEBOUNCE_MS);
  return () => clearTimeout(timer);
}, [menuType, query, workspaceId]);
```

3. `detectTrigger`：删 `fileMatch` 分支整段（含 `setFileMode`），保留 cmdMatch 短路 + atMatch/taskMatch。
4. `selectFile` 收敛（`insertMention` 的 Task 1 放宽正则可替换 `@src/pack` 局部）：

```ts
/** 文件选择（v2.11.1 统一）：与 agent 同形插 @路径（insertMention 放宽正则
 *  覆盖 '@路径局部'），另登记结构化 pendingFiles */
const selectFile = (f: SearchHit): void => {
  insertMention(`@${f.path}`);
  setPendingFiles((prev) =>
    prev.some((x) => x.path === f.path) ? prev : [...prev, { path: f.path }],
  );
};
```

5. 📎 `fileTriggerTick` effect：追加文本 `'@/'` → `'@'`，注释同步（「v2.11.1：@ 统一菜单——直接打开含默认列表的菜单」）。
6. JSX：`menuType === 'agent'` 两块（成员块 + 文件块）合并为一块，任一组命中即渲染：

```tsx
{menuType === 'agent' && (filteredMembers.length > 0 || fileHits.length > 0) && (
  <div className="absolute bottom-full left-3 right-3 mb-1 border border-subtle bg-surface-1 rounded-lg shadow-lg py-1 max-h-48 overflow-auto z-50">
    {filteredMembers.length > 0 && (
      <>
        <div className="px-3 py-1 text-xs text-tertiary">选择要 @ 的 agent</div>
        {filteredMembers.map((m) => (
          <button key={m.instanceId} type="button" onClick={() => selectMember(m)}
            className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2">
            <span>{m.iconEmoji ?? <Bot size={12} strokeWidth={1.75} aria-hidden />}</span>
            <span className="truncate">{m.agentName}</span>
          </button>
        ))}
      </>
    )}
    {fileHits.length > 0 && (
      <>
        <div className="px-3 py-1 text-xs text-tertiary">引用文件</div>
        {fileHits.map((f) => (
          <button key={f.path} type="button" onClick={() => selectFile(f)}
            className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2">
            <FileText size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="truncate">{f.path}</span>
          </button>
        ))}
      </>
    )}
  </div>
)}
```

7. 头部注释与 `handleSend` / 会话切换 effect 中所有 `@/` 措辞改为 `@` 统一表述。

- [ ] **Step 4: 跑测试确认绿**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`
Expected: 全文件 PASS（含 Task 1 中文用例、发送/草稿/IME 回归组）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/MentionInput.test.tsx
git commit -m "feat: @ 统一菜单——移除 @/ 独立语法，agent+文件同浮层，📎 直开含默认列表"
```

---

### Task 3: Kimi 式输入容器（框内 chips + 📎 左下）

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx:431-640`（JSX 容器重构）
- Modify: `renderer/src/components/im/InputToolbar.tsx`（移除 📎）
- Test: `renderer/src/components/im/MentionInput.test.tsx`（新增布局 describe）
- Test: `renderer/src/components/im/InputToolbar.test.tsx`（删 📎 describe）

**Interfaces:**
- Consumes: Task 2 的 `fileTriggerTick` 信号机制（不变——`useSessionStore.getState().bumpFileTrigger()`）
- Produces: 单一容器框视觉结构；`IconButton`（`renderer/src/components/ui/IconButton.tsx`）+ `Paperclip` 进入 MentionInput；chips 三类（mention/skill/file）渲染逻辑与可移除契约不变

- [ ] **Step 1: 写失败测试**——`MentionInput.test.tsx` 追加：

```tsx
// === v2.11.1 F3：Kimi 式容器——chips 与 📎 在输入框容器内 ===
describe('MentionInput Kimi 式容器（v2.11.1 F3）', () => {
  it('chips 渲染在输入框容器内（非顶置工具条）', async () => {
    mockApi.file.searchNames.mockResolvedValue([{ path: 'a.ts', isDirectory: false }]);
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@a' } });
    fireEvent.click(await screen.findByText('a.ts'));
    const chip = screen.getByLabelText('移除文件 a.ts');
    expect(chip.closest('.rounded-lg')).toBeTruthy(); // 容器框内
  });

  it('📎 在输入框容器内左下角且触发 bumpFileTrigger', async () => {
    render(<MentionInput />);
    const btn = screen.getByLabelText('引用文件');
    expect(btn.closest('.rounded-lg')).toBeTruthy();
    fireEvent.click(btn);
    expect(sessionState.fileTriggerTick).toBe(1); // bumpFileTrigger 经真实 store mock 生效——见实现注
  });

  it('readOnly → 📎 禁用；无 chips 时底行仅 📎', () => {
    sessionState.activeSessionReadOnly = true;
    render(<MentionInput />);
    expect((screen.getByLabelText('引用文件') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/移除/)).toBeNull();
  });
});
```

实现注：📎 点击断言依赖 `bumpFileTrigger` 真正递增 store——`sessionState` mock 需在测试内补 `bumpFileTrigger: vi.fn(() => { sessionState.fileTriggerTick += 1; })`（`vi.hoisted` 对象内新增字段 + `resetState` 重置 tick=0 并还原实现：`sessionState.bumpFileTrigger = vi.fn(() => { sessionState.fileTriggerTick += 1; })`）。

`InputToolbar.test.tsx`：删除 `describe('InputToolbar 📎 文件引用按钮（Task 10）', ...)` 整块与 `Paperclip`/`session.store` 相关 mock（若仅 📎 使用），头注释更新为「成员切换 + 创建任务按钮（📎 已移入 MentionInput 容器，v2.11.1）」。

- [ ] **Step 2: 跑测试确认红**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx src/components/im/InputToolbar.test.tsx`
Expected: 新 describe FAIL（📎 不存在于 MentionInput / chips 无容器祖先）；InputToolbar 全绿（删的是旧块）

- [ ] **Step 3: 实现**

1. `InputToolbar.tsx`：删 `Paperclip`/`IconButton` import 与 📎 `<IconButton>` 块，头注释更新。
2. `MentionInput.tsx` JSX：chips 行从 textarea 上方迁入容器底行，textarea 去边框，📎 入容器——

```tsx
return (
  <div className="border-t border-subtle bg-surface-1 p-3 relative">
    {/* 菜单浮层（absolute bottom-full）原样保留——锚点是外层 wrapper */}
    {readOnly && (/* 只读提示原样，位于容器外上方 */)}
    {commandHint && (/* 命令提示原样，位于容器外上方 */)}
    {/* Kimi 式单一容器（v2.11.1 F3）：textarea 无边框置顶；框内底行 = 📎 左下 +
        chips 换行限高滚动；focus 态上移容器边框 */}
    <div className="rounded-lg border border-subtle bg-surface-2 focus-within:border-focus transition-colors">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={!activeSessionId || readOnly}
        placeholder={/* 原三元不变 */}
        rows={2}
        className="w-full resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-primary placeholder:text-disabled focus:outline-none disabled:opacity-50"
      />
      <div className="flex items-end gap-2 px-2 pb-2">
        <IconButton
          aria-label="引用文件"
          title="引用文件"
          disabled={!activeSessionId || readOnly}
          onClick={() => useSessionStore.getState().bumpFileTrigger()}
        >
          <Paperclip size={16} strokeWidth={1.75} aria-hidden />
        </IconButton>
        {(pendingMentions.length > 0 || pendingSkills.length > 0 || pendingFiles.length > 0) && (
          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
            {/* 三类 chip 按现样式原样迁入（mention → skill → file 顺序与
                aria-label/移除回调均不变），仅去掉原外层行的 mb-2 */}
          </div>
        )}
      </div>
    </div>
  </div>
);
```

import 增加：`import { Bot, FileText, Lock, Pin, Terminal, X, Zap, Paperclip } from 'lucide-react';`（在现 lucide import 上加 `Paperclip`）与 `import { IconButton } from '../ui/IconButton';`。

- [ ] **Step 4: 跑测试确认绿**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx src/components/im/InputToolbar.test.tsx`
Expected: 两文件全 PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/InputToolbar.tsx renderer/src/components/im/MentionInput.test.tsx renderer/src/components/im/InputToolbar.test.tsx
git commit -m "feat: Kimi 式输入容器——chips 移入框内底部，📎 框内左下角"
```

---

### Task 4: e2e 触发流更新 + CHANGELOG + 全量验证

**Files:**
- Modify: `tests/e2e/composer-context.spec.ts:153-165`（`@/` → `@`）及文件头注释（5-9 行）
- Modify: `CHANGELOG.md`（v2.11 账目节追加交互精简行）

**Interfaces:**
- Consumes: Task 2/3 完成后的统一交互（e2e 断言 `@package.json` 正文标记）
- Produces: 无（收尾任务）

- [ ] **Step 1: 更新 e2e 触发流**

`composer-context.spec.ts` 内：
- `await input.fill('@/package');` → `await input.fill('@package');`
- 断言中的正文标记 `@/package.json` → `@package.json`（如有）
- 头注释「@/ 文件引用菜单」表述 → 「@ 统一菜单（agent+文件同浮层，v2.11.1）」

- [ ] **Step 2: CHANGELOG 账目**（「会话输入框上下文系统（v2.11 账本）」节末尾、`已知边界` 行之前追加）

```markdown
- **交互精简（v2.11.1 主机验收反馈）**：`@` 统一菜单（agent + 文件同浮层双源过滤，移除 `@/` 独立语法，文件标记 `@路径` 与 agent 同形）；`/`、`@`、`#` 触发正则放宽为非空白字符集——中文名直接过滤；📎 点击直开菜单 + 空查询根目录默认文件列表（`file.list`，主进程零改动）；chips 自顶置工具条移入输入框容器内底部（Kimi 式），📎 移至框内左下角
```

- [ ] **Step 3: 全量验证**

```bash
nvm use 20
npx pnpm@9.0.0 typecheck          # 双 workspace 零错
cd renderer && npx pnpm@9.0.0 vitest run   # 全绿（1361+ 用例）
cd .. && npx pnpm@9.0.0 build     # e2e 前置构建
cd electron && npx electron-rebuild -f -w better-sqlite3   # 切 Electron ABI
cd .. && xvfb-run -a npx pnpm@9.0.0 e2e tests/e2e/composer-context.spec.ts   # PASS
cd electron/node_modules/better-sqlite3 && npx prebuild-install   # 恢复 Node ABI
cd ../../.. && cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-resume.test.ts   # ABI 恢复抽查（dlopen 实证）
```

Expected: typecheck 零错；renderer 全绿；e2e 1 passed；ABI 恢复抽查绿

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/composer-context.spec.ts CHANGELOG.md
git commit -m "test: e2e 适配 @ 统一菜单触发流 + CHANGELOG v2.11.1 交互精简账目"
```

---

## Self-Review 记录

- **Spec 覆盖**：F1→Task 1；F2（@ 统一 + 默认列表 + 📎）→Task 2；F3（框内 chips + 📎 左下）→Task 3；§5 测试策略的四组用例分布在 Task 1/2/3 + e2e Task 4。无缺口。
- **占位符**：无 TBD/TODO；Task 3 chips 迁移处以「原样迁入」指明来源与不变契约（样式/aria-label/回调），代码块给出容器结构全貌——非新逻辑，迁移动词明确。
- **类型一致**：`SearchHit { path, isDirectory }`（现名不变）；`DirEntry { name, isDirectory, size }` → 映射 `{ path: e.name, isDirectory: false }`；`bumpFileTrigger` 与 `fileTriggerTick` 沿用现 store 契约；`insertMention(marker: string)` 签名不变。
