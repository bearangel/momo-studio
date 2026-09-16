// renderer/src/components/im/MentionInput.tsx
//
// 现役消息输入框（P3 Task 3：@ + # 双语法输入框替换 MessageInput）。
//   - 输入 @ 触发 agent 菜单：数据源 session.store.members（当前会话成员），
//     仅列 lastRunning 在线成员；选择时记录 instanceId，
//     发送经 session.store.sendMessage(body, mentionedInstanceIds) 透传
//   - 输入 #T 触发任务菜单：数据源 task.store.tasks（v2.3 起全生命周期任务），
//     本地 MENU_STATUSES 过滤（draft/pending/assigned）是唯一过滤点，
//     选择后向正文插入 #T-xxx 文本——后端 conflict-detector 从正文解析任务引用，
//     不进 sendMessage 载荷（纯 renderer affordance）
//   - 输入 @/ 触发文件菜单（Task 8）：数据源 ipc.file.searchNames（FileTree 同
//     形态直接调用，不经 file.store），debounce 200ms / 空查询不搜索 / 仅文件
//     （isDirectory === false）/ 限 8 条；选择后向正文插入 @/路径 标记并登记
//     pendingFiles chip（发送清空、失败恢复、会话切换清空——正文标记文本随
//     草稿保留，chips 不按标记重建为 MVP 取舍）
//   - 输入 / 触发命令+技能菜单（Task 9，spec §7.1）：仅空 body 以 / 开头触发
//     （正则 ^\/([A-Za-z0-9-]*)$ 锚定整串）；命令组数据源 ipc.session.listCommands
//     （主进程 commands.ts 单一真相源），选择 = insertMention('/name') 插正文，
//     Enter 沿用既有 / 命令路径执行；技能组数据源 ipc.resource.list({ type: 'skill' })
//     过滤 installed，选择 = pendingSkills chip（不插正文），随 context 第 3 参发送
//   - 手动键入 @ 文本（不经菜单选择）不注册 mention——与原 MessageInput 一致
//   - 空态 parity：无激活会话禁用 + placeholder 提示；发送失败恢复正文与 mentions
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, FileText, Lock, Pin, Terminal, X, Zap } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import type {
  FileContextItem,
  MessageContext,
  SearchHit,
  SessionMemberInfo,
  SkillContextItem,
  TaskRow,
  TaskStatus,
} from '../../ipc/types';

type MenuKind = 'agent' | 'task' | 'command';

/** # 菜单仅展示可激活态（v2.3：store 全量拉取后此过滤成为唯一防线） */
const MENU_STATUSES: ReadonlyArray<TaskStatus> = ['draft', 'pending', 'assigned'];
/** 菜单最多展示条目数（pending 任务可能较多） */
const MENU_LIMIT = 10;
/** @/ 文件菜单最多展示条目数（主进程 searchNames 默认 limit 200，renderer 端截取） */
const FILE_MENU_LIMIT = 8;
/** / 菜单命令组 / 技能组各自最多展示条目数（与 @ 菜单分组限额对齐） */
const COMMAND_MENU_LIMIT = 8;
/** 文件搜索防抖间隔（毫秒），与 FileTree 的 SEARCH_DEBOUNCE_MS 对齐 */
const FILE_SEARCH_DEBOUNCE_MS = 200;

export function MentionInput() {
  const [text, setText] = useState('');
  const [menuType, setMenuType] = useState<MenuKind | null>(null);
  const [query, setQuery] = useState('');
  // @ 目标 instanceId 列表（菜单选择时记录，发送后清空；失败恢复）
  const [pendingMentions, setPendingMentions] = useState<string[]>([]);
  // @/ 文件引用列表（Task 8）：菜单选择时记录 { path }，与 pendingMentions 同
  // 生命周期——发送清空 / 失败恢复 / 会话切换清空
  const [pendingFiles, setPendingFiles] = useState<FileContextItem[]>([]);
  // / 菜单技能列表（Task 9）：选择时记录 { slug, name }（name 为选择时资源索引
  // 快照，chip 渲染不反查），与 pendingFiles 同生命周期
  const [pendingSkills, setPendingSkills] = useState<SkillContextItem[]>([]);
  // @/ 文件触发态与局部查询（fileMode=true 时 @ 菜单只展示文件组）
  const [fileMode, setFileMode] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  // 文件搜索命中（searchNames 过滤目录后的文件子集，限 FILE_MENU_LIMIT 条）
  const [fileHits, setFileHits] = useState<SearchHit[]>([]);
  // 文件搜索竞态守卫：响应返回时序号不匹配则丢弃（与 FileTree 一致）
  const fileSearchSeqRef = useRef(0);
  // / 菜单两组数据缓存（Task 9）：命令注册表 + 已安装技能（挂载时拉取一次，
  // 均为全局数据不随会话切换；失败静默——菜单数据缺失不阻塞输入）
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [skillItems, setSkillItems] = useState<Array<{ slug: string; name: string }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const members = useSessionStore((s) => s.members);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  // 只读态（有效成员全失效，spec §7）与聚焦信号（新建会话后聚焦，spec §6.2）
  const readOnly = useSessionStore((s) => s.activeSessionReadOnly);
  const inputFocusTick = useSessionStore((s) => s.inputFocusTick);
  // 斜杠命令提示（spec §5.4）：成功 message 或失败 Error.message；下一次正常
  // 发消息时 store 自动置 null
  const commandHint = useSessionStore((s) => s.commandHint);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { tasks, load: loadTasks } = useTaskStore();

  // 新建会话成功（inputFocusTick 递增）→ 聚焦输入框，⚡ 免弹窗直达后立即可输入
  useEffect(() => {
    if (inputFocusTick > 0) textareaRef.current?.focus();
  }, [inputFocusTick]);

  // 会话级草稿：切换会话时保存当前草稿、恢复目标会话草稿（无则空）。
  // 此前 text 是组件本地 state，切会话后内容残留串台。
  const draftsRef = useRef<Map<string, string>>(new Map());
  const prevSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current === activeSessionId) return;
    if (prevSessionRef.current !== null) draftsRef.current.set(prevSessionRef.current, text);
    const next = activeSessionId !== null ? (draftsRef.current.get(activeSessionId) ?? '') : '';
    setText(next);
    setMenuType(null);
    setQuery('');
    setFileMode(false);
    // MVP 取舍：文件 chips 不按正文里的 @/ 标记重建（正文文本随草稿自然保留），
    // 切会话即清空——chips 重建留待后续增强；技能 chips 同生命周期
    setPendingFiles([]);
    setPendingSkills([]);
    prevSessionRef.current = activeSessionId;
    // text 刻意不入依赖：仅在会话切换边界执行存取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // @/ 文件搜索（Task 8）：debounce 200ms 调 ipc.file.searchNames（FileTree 同
  // 形态——(workspaceId, query) 二参，不经 file.store）；空 query 不搜索；
  // 仅保留文件命中（isDirectory === false）并截取 FILE_MENU_LIMIT 条。
  // 依赖取 workspace?.id（字符串）而非 workspace 对象——对象引用每渲染一换，
  // 配合 setState 会构成无限渲染环；seqRef 竞态守卫：旧响应不覆盖新结果。
  const workspaceId = workspace?.id;
  useEffect(() => {
    if (!fileMode) {
      // 退出文件模式：命中集被渲染门控（fileMode && ...）隐藏，无需清空，
      // 仅失效在途请求
      fileSearchSeqRef.current++;
      return;
    }
    const trimmed = fileQuery.trim();
    if (trimmed === '') {
      fileSearchSeqRef.current++;
      // 引用守卫：已空则原引用返回，避免无谓重渲
      setFileHits((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const timer = setTimeout(() => {
      if (!workspaceId) return;
      const seq = ++fileSearchSeqRef.current;
      ipc.file
        .searchNames(workspaceId, trimmed)
        .then((hits) => {
          if (fileSearchSeqRef.current !== seq) return;
          setFileHits(hits.filter((h) => !h.isDirectory).slice(0, FILE_MENU_LIMIT));
        })
        .catch(() => {
          // 搜索失败静默清空（菜单随之收起）；与 FileTree 不同，此处无专用错误
          // 文案位——菜单是瞬时 affordance，用户继续输入即重试
          if (fileSearchSeqRef.current !== seq) return;
          setFileHits((prev) => (prev.length > 0 ? [] : prev));
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fileMode, fileQuery, workspaceId]);

  // # 菜单数据接线：task.store 此前仅 TaskBoardView（tasks 视图）加载，
  // IM 视图挂载时主动拉取当前 workspace 的任务（v2.3 起为全生命周期，
  // 可激活态过滤由上方 MENU_STATUSES 本地承载）
  useEffect(() => {
    if (workspace) void loadTasks(workspace.id);
  }, [workspace, loadTasks]);

  // / 菜单数据接线（Task 9）：命令组 + 技能组并行拉取缓存。调用形态照
  // resource.store.load 的 ipc.resource.list(filter)（type 维度后端过滤），
  // 但不走 store——store 的 typeFilter 是资源库页面的 tab 全局态，此处需要
  // 固定 { type: 'skill' } 视图（与 Task 8 file.searchNames 直调同理）
  useEffect(() => {
    void ipc.session.listCommands().then(setCommands).catch(() => {});
    void ipc.resource
      .list({ type: 'skill' })
      .then((items) =>
        setSkillItems(
          items.filter((i) => i.installed).map((i) => ({ slug: i.slug, name: i.name })),
        ),
      )
      .catch(() => {});
  }, []);

  // 在线成员判定与 MembersPanel 同源：lastRunning = 用户最近运行意图
  const filteredMembers =
    menuType === 'agent'
      ? members
          .filter((m) => m.lastRunning)
          .filter((m) => {
            if (!query) return true;
            return m.agentName.toLowerCase().includes(query.toLowerCase());
          })
          .slice(0, MENU_LIMIT)
      : [];

  const filteredTasks =
    menuType === 'task'
      ? tasks
          .filter(
            (t) =>
              MENU_STATUSES.includes(t.status) &&
              (!query ||
                t.id.toLowerCase().includes(query.toLowerCase()) ||
                t.title.toLowerCase().includes(query.toLowerCase())),
          )
          .slice(0, MENU_LIMIT)
      : [];

  const filteredCommands =
    menuType === 'command'
      ? commands
          .filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, COMMAND_MENU_LIMIT)
      : [];

  const filteredSkills =
    menuType === 'command'
      ? skillItems
          .filter(
            (s) =>
              !query ||
              s.slug.toLowerCase().includes(query.toLowerCase()) ||
              s.name.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, COMMAND_MENU_LIMIT)
      : [];

  /** 光标前缀触发检测：命令整串锚定（仅空 body）/ @/ 接文件路径局部 / @ 接 slug 局部 / # 接 T-数字局部（输入事件时刻取光标值，防中间输入漂移） */
  const detectTrigger = (newValue: string, cursorPos: number): void => {
    const before = newValue.slice(0, cursorPos);
    // 命令分支在最前并短路返回（Task 8 教训：新分支不短路会落入后续 else 清空
    // menuType）。正则锚定整串——仅空 body 以 / 开头才触发：句中 / 不命中；
    // '//' 转义（第二个 / 不在 [A-Za-z0-9-] 字符集）也不命中，strip 语义在
    // session.store.sendMessage，菜单不越权
    const cmdMatch = before.match(/^\/([A-Za-z0-9-]*)$/);
    if (cmdMatch) {
      setMenuType('command');
      setQuery(cmdMatch[1] ?? '');
      setFileMode(false);
      return;
    }
    // 文件分支在前并短路返回：@/ 前缀走文件搜索。现有 @ 成员正则
    // `(?:^|\s)@([A-Za-z0-9-]*)$` 字符集不含 '/'，与本法互斥——若不短路，
    // '@/x' 会落入下方 else 分支把 menuType 清空
    const fileMatch = before.match(/(?:^|\s)@\/([^\s]*)$/);
    if (fileMatch) {
      setMenuType('agent'); // 文件并入 @ 菜单分组展示
      setFileQuery(fileMatch[1] ?? '');
      setFileMode(true);
      return;
    }
    setFileMode(false);
    const atMatch = before.match(/(?:^|\s)@([A-Za-z0-9-]*)$/);
    // 任务 trigger 允许 T-/数字 的任意局部输入，有效性在 filteredTasks 按 id/title 过滤
    const taskMatch = before.match(/(?:^|\s)#([A-Za-z0-9-]*)$/);
    if (atMatch) {
      setMenuType('agent');
      setQuery(atMatch[1] ?? '');
    } else if (taskMatch) {
      setMenuType('task');
      setQuery(taskMatch[1] ?? '');
    } else {
      setMenuType(null);
      setQuery('');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setText(newValue);
    detectTrigger(newValue, e.target.selectionStart ?? newValue.length);
  };

  /** 替换光标前最近的 @xxx / #T-xxx / /xxx 局部输入为完整标记；尾随空格防继续输入粘连破坏 mention 边界 */
  const insertMention = (marker: string): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = text.slice(0, pos);
    const after = text.slice(pos);
    // 局部匹配字符集与 detectTrigger 一致（覆盖 '@'、'#T'、'/com' 等未敲完的
    // 局部输入；'/' sigil 为 Task 9 命令选择追加——字符集本就匹配，仅缺 sigil）
    const newValue =
      before.replace(
        /(?:^|\s)(@[A-Za-z0-9-]*$|#[A-Za-z0-9-]*$|\/[A-Za-z0-9-]*$)/,
        (match, partial: string) => match.replace(partial, marker),
      ) + ' ' + after;
    setText(newValue);
    setMenuType(null);
    setQuery('');
    // 焦点与光标回到标记末尾（菜单按钮点击会移走焦点）
    setTimeout(() => {
      ta.focus();
      const newPos = newValue.length - after.length;
      ta.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const selectMember = (m: SessionMemberInfo): void => {
    insertMention(`@${m.agentName}`);
    setPendingMentions((prev) =>
      prev.includes(m.instanceId) ? prev : [...prev, m.instanceId],
    );
  };

  const selectTask = (t: TaskRow): void => {
    insertMention(`#${t.id}`);
  };

  const selectCommand = (name: string): void => {
    insertMention(`/${name}`);
  };

  /** 技能选择（Task 9）：不插正文（skill 正文在主进程 context-expander 展开），
   * 剥掉光标前的 /局部 输入并登记 chip——命令触发条件保证该局部即整串 body */
  const selectSkill = (s: SkillContextItem): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const after = text.slice(ta.selectionStart);
    setText(after);
    setMenuType(null);
    setQuery('');
    setFileMode(false);
    setPendingSkills((prev) =>
      prev.some((x) => x.slug === s.slug) ? prev : [...prev, s],
    );
    setTimeout(() => {
      ta.focus();
    }, 0);
  };

  /** insertMention 的文件变体：现有正则字符集不含 '/'，无法覆盖 @/ 局部输入。
   * 回调式替换保留前导空白（与 insertMention 同法）——句中 "word @/a" 选择后
   * 不吃掉 @ 前的空格；裸 replace 整段匹配会把前导空白一并吞掉 */
  const selectFile = (f: SearchHit): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = text.slice(0, pos);
    const after = text.slice(pos);
    // 局部匹配字符集与 detectTrigger 文件分支一致（覆盖未敲完的 @/xxx 局部输入）
    const newValue =
      before.replace(
        /(?:^|\s)(@\/[^\s]*$)/,
        (match, partial: string) => match.replace(partial, `@/${f.path}`),
      ) + ' ' + after;
    setText(newValue);
    setMenuType(null);
    setQuery('');
    setFileMode(false);
    setPendingFiles((prev) =>
      prev.some((x) => x.path === f.path) ? prev : [...prev, { path: f.path }],
    );
    // 焦点与光标回到标记末尾（菜单按钮点击会移走焦点）
    setTimeout(() => {
      ta.focus();
      const np = newValue.length - after.length;
      ta.setSelectionRange(np, np);
    }, 0);
  };

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim();
    // 空 body + context 是合法消息（spec §7.1：skill 正文即 prompt）
    const hasContext = pendingSkills.length > 0 || pendingFiles.length > 0;
    if ((!trimmed && !hasContext) || !activeSessionId) return;
    const mentions = pendingMentions.length > 0 ? [...pendingMentions] : undefined;
    const context: MessageContext | undefined = hasContext
      ? { skills: [...pendingSkills], files: [...pendingFiles] }
      : undefined;
    setText('');
    setPendingMentions([]);
    setPendingFiles([]);
    setPendingSkills([]);
    setMenuType(null);
    setQuery('');
    setFileMode(false);
    try {
      // context（{ skills, files } 第 3 参）：主进程落 messages.context_json，
      // 派发时展开为正文 <user-context> 块（v2.11 Task 7 契约）
      await sendMessage(trimmed, mentions, context);
      await loadSessions();
    } catch {
      // 发送失败恢复正文与 mentions / 文件与技能 chips，用户可修改后重发
      setText(trimmed);
      if (mentions) setPendingMentions(mentions);
      if (context?.files.length) setPendingFiles(context.files);
      if (context?.skills.length) setPendingSkills(context.skills);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuType !== null && e.key === 'Escape') {
      setMenuType(null);
      setFileMode(false);
      return;
    }
    // 输入法组合期（中文拼音选字等）的 Enter 是选字确认不是发送——
    // isComposing 或历史 keyCode 229（Safari 等 IME 事件）都跳过
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 菜单激活时 Enter 不发送（避免选菜单途中误发），Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && menuType === null) {
      e.preventDefault();
      void handleSend();
    }
  };

  /** instanceId → 展示名（mention chip 用；不在成员列表时回退 id） */
  const mentionDisplayName = (instanceId: string): string => {
    return members.find((m) => m.instanceId === instanceId)?.agentName ?? instanceId;
  };

  return (
    <div className="border-t border-subtle bg-surface-1 p-3 relative">
      {/* 成员组在 fileMode 下隐藏：@/ 局部输入无法被 insertMention 的成员字符集
          匹配（不含 '/'），此时点成员会静默丢失标记——文件意图期间只展示文件组 */}
      {menuType === 'agent' && !fileMode && filteredMembers.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 border border-subtle bg-surface-1 rounded-lg shadow-lg py-1 max-h-48 overflow-auto z-50">
          <div className="px-3 py-1 text-xs text-tertiary">选择要 @ 的 agent</div>
          {filteredMembers.map((m) => (
            <button
              key={m.instanceId}
              type="button"
              onClick={() => selectMember(m)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2"
            >
              <span>
                {m.iconEmoji ?? <Bot size={12} strokeWidth={1.75} aria-hidden />}
              </span>
              <span className="truncate">{m.agentName}</span>
            </button>
          ))}
        </div>
      )}

      {menuType === 'agent' && fileMode && fileHits.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 border border-subtle bg-surface-1 rounded-lg shadow-lg py-1 max-h-48 overflow-auto z-50">
          <div className="px-3 py-1 text-xs text-tertiary">选择要引用的文件</div>
          {fileHits.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => selectFile(f)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2"
            >
              <FileText size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
              <span className="truncate">{f.path}</span>
            </button>
          ))}
        </div>
      )}

      {menuType === 'task' && filteredTasks.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 border border-subtle bg-surface-1 rounded-lg shadow-lg py-1 max-h-48 overflow-auto z-50">
          <div className="px-3 py-1 text-xs text-tertiary">选择要引用的任务</div>
          {filteredTasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTask(t)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2"
            >
              <Pin size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
              <span className="truncate">
                #{t.id} · {t.title}
              </span>
            </button>
          ))}
        </div>
      )}

      {menuType === 'command' && (filteredCommands.length > 0 || filteredSkills.length > 0) && (
        <div className="absolute bottom-full left-3 right-3 mb-1 border border-subtle bg-surface-1 rounded-lg shadow-lg py-1 max-h-48 overflow-auto z-50">
          {filteredCommands.length > 0 && (
            <>
              <div className="px-3 py-1 text-xs text-tertiary">命令</div>
              {filteredCommands.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => selectCommand(c.name)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2"
                >
                  <Terminal size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span className="truncate">{`/${c.name}`}</span>
                  <span className="truncate text-tertiary">{c.description}</span>
                </button>
              ))}
            </>
          )}
          {filteredSkills.length > 0 && (
            <>
              <div className="px-3 py-1 text-xs text-tertiary">技能</div>
              {filteredSkills.map((s) => (
                <button
                  key={s.slug}
                  type="button"
                  onClick={() => selectSkill(s)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2"
                >
                  <Zap size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                  <span className="truncate">{s.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {(pendingMentions.length > 0 || pendingFiles.length > 0 || pendingSkills.length > 0) && (
        <div className="flex flex-wrap gap-1 mb-2">
          {pendingMentions.map((instanceId) => (
            <button
              key={instanceId}
              type="button"
              aria-label={`移除 @${mentionDisplayName(instanceId)}`}
              onClick={() =>
                setPendingMentions((prev) => prev.filter((m) => m !== instanceId))
              }
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:bg-status-error-tint hover:text-status-error"
            >
              @{mentionDisplayName(instanceId)}
              <X size={11} strokeWidth={1.75} aria-hidden />
            </button>
          ))}
          {pendingSkills.map((s) => (
            <button
              key={`skill-${s.slug}`}
              type="button"
              aria-label={`移除技能 ${s.name}`}
              onClick={() => setPendingSkills((prev) => prev.filter((x) => x.slug !== s.slug))}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-active text-secondary hover:bg-status-error-tint hover:text-status-error"
            >
              <Zap size={11} strokeWidth={1.75} aria-hidden />
              {s.name}
              <X size={11} strokeWidth={1.75} aria-hidden />
            </button>
          ))}
          {pendingFiles.map((f) => (
            <button
              key={`file-${f.path}`}
              type="button"
              aria-label={`移除文件 ${f.path}`}
              onClick={() => setPendingFiles((prev) => prev.filter((x) => x.path !== f.path))}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-active text-secondary hover:bg-status-error-tint hover:text-status-error"
            >
              <FileText size={11} strokeWidth={1.75} aria-hidden />
              {f.path.split('/').pop()}
              <X size={11} strokeWidth={1.75} aria-hidden />
            </button>
          ))}
        </div>
      )}

      {readOnly && (
        <div className="mb-2 text-xs text-tertiary inline-flex items-center gap-1">
          <Lock size={12} strokeWidth={1.75} aria-hidden className="inline-block align-[-1px]" />
          <span>会话成员已全部移出，会话只读（历史可查看）</span>
        </div>
      )}

      {commandHint && (
        <div className="px-3 py-1 text-xs text-secondary border-t border-subtle">{commandHint}</div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={!activeSessionId || readOnly}
        placeholder={
          readOnly
            ? '会话只读'
            : activeSessionId
              ? '输入消息，Enter 发送。输入 @ 提到 agent，# 引用任务'
              : '请先选择房间'
        }
        rows={2}
        className="w-full resize-none rounded-md border border-subtle bg-surface-2 px-3 py-2 text-sm text-primary placeholder:text-disabled focus:border-focus focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
