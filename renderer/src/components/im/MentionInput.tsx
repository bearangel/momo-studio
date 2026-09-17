// renderer/src/components/im/MentionInput.tsx
//
// 现役消息输入框（v3 Task 3：以 RichComposer 内联 pill 富输入块替换 textarea，
// 退役底部 chip 行与 pendingMentions/pendingFiles/pendingSkills 三数组——
// spec 2026-09-17-rich-composer-inline-pills-design）。
//   - 编辑面是 RichComposer（contentEditable）：五类引用（agent/文件/任务/
//     技能/命令）是文字流中的原子 pill，DOM 由 imperative handle 操纵，
//     React 不传 children
//   - @ 统一菜单（v2.11.1 F2）：agent 组 + 文件组同浮层渲染，同 query 双源；
//     成员数据源 session.store.members（仅 lastRunning 在线成员），文件数据源
//     双形态（空 query → ipc.file.list('.') 根目录默认列表，非空 → debounce
//     200ms ipc.file.searchNames）；选择成员 → agent pill（data-id=instanceId，
//     序列化进 sendMessage 第 2 参 mentionedInstanceIds）；选择文件 → file pill
//     （data-id=路径，序列化进 body `@路径` + context.files）
//   - #T 任务菜单：数据源 task.store.tasks，本地 MENU_STATUSES 过滤
//     （draft/pending/assigned）是唯一过滤点，选择 → task pill（序列化进
//     body `#id`——后端 conflict-detector 从正文解析，不进 sendMessage 载荷）
//   - / 命令+技能菜单（spec §7.1）：仅空 body 以 / 开头触发（正则
//     ^\/([^\s/]*)$ 锚定整串——pill 折叠为空格使命令/技能 pill 只能是
//     编辑器第一个节点，整串语义保持）；命令组 ipc.session.listCommands，
//     选择 → command pill（序列化进 body `/name`）；技能组
//     ipc.resource.list({ type: 'skill' }) 过滤 installed，选择 → skill pill
//     （不进正文，随 context 第 3 参发送）
//   - 发送：serializeSegments(getSegments()) 一次性提取
//     sendMessage(body, mentions, context) 三参；失败恢复 setSegments 快照
//     （pill 原位）；空 body + 仅技能/文件 pill 是合法消息（v2.11 §7.1）
//   - 会话草稿：draftsRef 存 segments JSON（segmentsToDraft/draftToSegments），
//     切回 pill 与正文原样恢复（旧版「chips 不重建」MVP 取舍随三数组退役）
//   - 手动键入 @ 文本（不经菜单选择）不注册 mention——与历代一致
//   - 空态 parity：无激活会话禁用 + placeholder 提示；IME/Enter/Escape 守卫
//     在 RichComposer 内（onEnter 回调只判菜单激活态）
//   - Kimi 式单一容器（v2.11.1 F3→v3）：RichComposer 无边框置于容器内，
//     框内底行仅剩 📎 左下角（chips 已由编辑器内联 pill 取代）
import { useEffect, useRef, useState } from 'react';
import { Bot, FileText, Lock, Paperclip, Pin, Terminal, Zap } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { IconButton } from '../ui/IconButton';
import { RichComposer, type RichComposerHandle } from './RichComposer';
import { draftToSegments, segmentsToDraft, serializeSegments } from './composer-segments';
import type { SearchHit, SessionMemberInfo, TaskRow, TaskStatus } from '../../ipc/types';

type MenuKind = 'agent' | 'task' | 'command';

/** # 菜单仅展示可激活态（v2.3：store 全量拉取后此过滤成为唯一防线） */
const MENU_STATUSES: ReadonlyArray<TaskStatus> = ['draft', 'pending', 'assigned'];
/** 菜单最多展示条目数（pending 任务可能较多） */
const MENU_LIMIT = 10;
/** @ 统一菜单文件组最多展示条目数（searchNames 命中与 file.list 根目录默认列表共用此上限，renderer 端截取） */
const FILE_MENU_LIMIT = 8;
/** / 菜单命令组 / 技能组各自最多展示条目数（与 @ 菜单分组限额对齐） */
const COMMAND_MENU_LIMIT = 8;
/** 文件搜索防抖间隔（毫秒），与 FileTree 的 SEARCH_DEBOUNCE_MS 对齐 */
const FILE_SEARCH_DEBOUNCE_MS = 200;

export function MentionInput() {
  const [menuType, setMenuType] = useState<MenuKind | null>(null);
  const [query, setQuery] = useState('');
  // 文件组命中（@ 菜单双源之一；空 query 显示 ipc.file.list('.') 根目录默认列表，
  // 非空 query debounce 200ms 调 searchNames；统一过滤目录 + 截 FILE_MENU_LIMIT）
  const [fileHits, setFileHits] = useState<SearchHit[]>([]);
  // 文件搜索竞态守卫：响应返回时序号不匹配则丢弃（与 FileTree 一致）
  const fileSearchSeqRef = useRef(0);
  // / 菜单两组数据缓存：命令注册表 + 已安装技能（挂载时拉取一次，均为全局
  // 数据不随会话切换；失败静默——菜单数据缺失不阻塞输入）
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [skillItems, setSkillItems] = useState<Array<{ slug: string; name: string }>>([]);
  const composerRef = useRef<RichComposerHandle>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const members = useSessionStore((s) => s.members);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  // 只读态（有效成员全失效，spec §7）与聚焦信号（新建会话后聚焦，spec §6.2）
  const readOnly = useSessionStore((s) => s.activeSessionReadOnly);
  const inputFocusTick = useSessionStore((s) => s.inputFocusTick);
  // 📎 文件引用触发信号：框内 📎 点击递增
  const fileTriggerTick = useSessionStore((s) => s.fileTriggerTick);
  // 斜杠命令提示（spec §5.4）：成功 message 或失败 Error.message；下一次正常
  // 发消息时 store 自动置 null
  const commandHint = useSessionStore((s) => s.commandHint);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { tasks, load: loadTasks } = useTaskStore();

  // 新建会话成功（inputFocusTick 递增）→ 聚焦编辑面，⚡ 免弹窗直达后立即可输入
  useEffect(() => {
    if (inputFocusTick > 0) composerRef.current?.focus();
  }, [inputFocusTick]);

  // 会话级草稿（segments JSON 往返）：切换会话时保存当前 segments、恢复目标
  // 会话草稿（无则清空）——pill 与文字同权保留，v2「chips 不重建」取舍随
  // 三数组退役。
  const draftsRef = useRef<Map<string, string>>(new Map());
  const prevSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current === activeSessionId) return;
    if (prevSessionRef.current !== null) {
      draftsRef.current.set(
        prevSessionRef.current,
        segmentsToDraft(composerRef.current?.getSegments() ?? []),
      );
    }
    const next =
      activeSessionId !== null ? draftsRef.current.get(activeSessionId) : undefined;
    composerRef.current?.setSegments(draftToSegments(next));
    setMenuType(null);
    setQuery('');
    // 跨 workspace 陈旧命中防闪现（终审 M1）：menuType 同步置 null 后文件 effect
    // 会跳过分支不清 fileHits；切会话时显式清空，下一次 @ 触发前菜单条件
    // (filteredMembers.length > 0 || fileHits.length > 0) 不会拿旧 ws 数据渲染
    setFileHits([]);
    prevSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  // @ 统一菜单文件组：query 双源之一。空 query → file.list('.') 根目录默认
  // 列表（仅文件截 FILE_MENU_LIMIT）；非空 → debounce 200ms searchNames
  // （FileTree 同形态）。seqRef 竞态守卫覆盖两路径。
  const workspaceId = workspace?.id;
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

  // # 菜单数据接线：task.store 此前仅 TaskBoardView 加载，IM 视图挂载时
  // 主动拉取当前 workspace 的任务（可激活态过滤由上方 MENU_STATUSES 承载）
  useEffect(() => {
    if (workspace) void loadTasks(workspace.id);
  }, [workspace, loadTasks]);

  // / 菜单数据接线：命令组 + 技能组并行拉取缓存（不走 store——store 的
  // typeFilter 是资源库页面的 tab 全局态，此处需要固定 { type: 'skill' } 视图）
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

  /**
   * 光标前缀触发检测（RichComposer onInputText 的 beforeCaret——pill 已折叠
   * 为单空格、剥 ZWSP）：命令整串锚定（仅空 body）/ @ 接 slug 与文件路径
   * 局部（统一菜单）/ # 接 T-数字局部。pill 折叠空格使 `^\/` 在 pill 存在时
   * 自然失效——命令/技能 pill 只能是编辑器第一个节点，整串语义保持。
   */
  const detectTrigger = (before: string): void => {
    // 命令分支在最前并短路返回（Task 8 教训：新分支不短路会落入后续 else
    // 清空 menuType）。正则锚定整串——仅空 body 以 / 开头才触发：句中 /
    // 不命中；'//' 转义（第二个 / 不在 [^\s/] 字符集）也不命中，strip 语义
    // 在 session.store.sendMessage，菜单不越权。字符集 [^\s/]（非空白且
    // 非 /）——支持中文命令/技能名过滤，同时保留 '//' 转义与句中 / 不触发
    const cmdMatch = before.match(/^\/([^\s/]*)$/);
    if (cmdMatch) {
      setMenuType('command');
      setQuery(cmdMatch[1] ?? '');
      return;
    }
    // 字符集 [^\s#]（非空白且非 #）——支持中文 agent 名过滤，含 '/' 是
    // 统一菜单的前置条件（selectFile 复插 @路径 局部）
    const atMatch = before.match(/(?:^|\s)@([^\s#]*)$/);
    // 字符集 [^\s@]（非空白且非 @）——支持中文任务标题过滤
    const taskMatch = before.match(/(?:^|\s)#([^\s@]*)$/);
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

  // 📎 文件引用触发：fileTriggerTick 递增 → 聚焦 + insertTextAtEnd('@')
  // 直开统一菜单（成员组空 + 文件组根目录默认列表）。insertTextAtEnd 内部
  // 派发 onInputText → detectTrigger 同步刷新菜单态——旧菜单（如已打开的
  // 命令菜单）立即让位，不残留到下一次输入。防粘连空格是 insertTextAtEnd
  // 自身语义（末可见字符非空白时补一个空格）。
  useEffect(() => {
    if (fileTriggerTick === 0) return;
    composerRef.current?.focus();
    composerRef.current?.insertTextAtEnd('@');
  }, [fileTriggerTick]);

  /**
   * 菜单选择统一形：把光标前的触发局部（sigil + 查询词，共
   * `1 + query.length` 字符）替换为原子 pill。insertPill 是静默的（不触发
   * onInputText）——必须显式关菜单清 query。
   */
  const selectWithPill = (
    pill: { kind: 'agent' | 'file' | 'task' | 'skill' | 'command'; id: string; label: string },
  ): void => {
    const replaceLen = 1 + query.length;
    composerRef.current?.insertPill({ type: 'pill', ...pill }, replaceLen);
    // 菜单 button 的 mousedown 偷走焦点（v2.11.1 insertMention 同款问题）——
    // 选择后显式恢复，否则键盘输入落空。insertPill 已设好 selection，focus
    // 保留元素内既有选区；勿用 moveCaretToEnd——中段插入场景会错误跳末尾
    composerRef.current?.focus();
    setMenuType(null);
    setQuery('');
  };

  const selectMember = (m: SessionMemberInfo): void => {
    selectWithPill({ kind: 'agent', id: m.instanceId, label: m.agentName });
  };

  const selectTask = (t: TaskRow): void => {
    selectWithPill({ kind: 'task', id: t.id, label: t.title });
  };

  const selectCommand = (name: string): void => {
    selectWithPill({ kind: 'command', id: name, label: name });
  };

  /** 技能选择：skill pill 不进正文（展开块由主进程 context-expander 注入） */
  const selectSkill = (s: { slug: string; name: string }): void => {
    selectWithPill({ kind: 'skill', id: s.slug, label: s.name });
  };

  /** 文件选择：与 agent 同形（id = 文件路径） */
  const selectFile = (f: SearchHit): void => {
    selectWithPill({ kind: 'file', id: f.path, label: f.path });
  };

  const handleSend = async (): Promise<void> => {
    // 发送前快照（失败恢复用）+ 序列化三参（body/mentions/context——
    // IPC 形状与 v2.11 完全一致，主进程零感知）
    const segs = composerRef.current?.getSegments() ?? [];
    const payload = serializeSegments(segs);
    const trimmed = payload.body.trim();
    // 空 body + context 是合法消息（spec §7.1：skill 正文即 prompt）
    const hasContext = !!payload.context;
    if ((!trimmed && !hasContext) || !activeSessionId) return;
    composerRef.current?.clear();
    setMenuType(null);
    setQuery('');
    try {
      await sendMessage(trimmed, payload.mentions, payload.context);
      await loadSessions();
    } catch {
      // 发送失败恢复：pill 原位 + 正文保留（setSegments 快照），用户可修改后重发
      composerRef.current?.setSegments(segs);
    }
  };

  return (
    <div className="border-t border-subtle bg-surface-1 p-3 relative">
      {/* @ 统一菜单——agent 组 + 文件组同浮层，任一组命中即渲染 */}
      {menuType === 'agent' && (filteredMembers.length > 0 || fileHits.length > 0) && (
        <div className="absolute bottom-full left-3 right-3 mb-1 border border-subtle bg-surface-1 rounded-lg shadow-lg py-1 max-h-48 overflow-auto z-50">
          {filteredMembers.length > 0 && (
            <>
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
            </>
          )}
          {fileHits.length > 0 && (
            <>
              <div className="px-3 py-1 text-xs text-tertiary">引用文件</div>
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
            </>
          )}
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

      {readOnly && (
        <div className="mb-2 text-xs text-tertiary inline-flex items-center gap-1">
          <Lock size={12} strokeWidth={1.75} aria-hidden className="inline-block align-[-1px]" />
          <span>会话成员已全部移出，会话只读（历史可查看）</span>
        </div>
      )}

      {commandHint && (
        <div className="px-3 py-1 text-xs text-secondary border-t border-subtle">{commandHint}</div>
      )}

      {/* Kimi 式单一容器（v3）：RichComposer 编辑面无边框置顶，pill 内联取代
          chips；框内底行仅剩 📎 左下角；focus 态上移容器边框 */}
      <div className="rounded-lg border border-subtle bg-surface-2 focus-within:border-focus transition-colors">
        <RichComposer
          ref={composerRef}
          disabled={!activeSessionId || readOnly}
          placeholder={
            readOnly
              ? '会话只读'
              : activeSessionId
                ? '输入消息，Enter 发送。@ 引用 agent 或文件，# 引用任务'
                : '请先选择房间'
          }
          ariaLabel="消息输入框"
          onInputText={(before) => detectTrigger(before)}
          onEnter={() => {
            // 菜单激活时 Enter 不发送（避免选菜单途中误发）；
            // IME/Shift+Enter 守卫在 RichComposer 内
            if (menuType !== null) return;
            void handleSend();
          }}
          onEscape={() => {
            setMenuType(null);
          }}
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
        </div>
      </div>
    </div>
  );
}
