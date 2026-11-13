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
//   - / 命令+技能菜单（spec §7.1；v3.1 句中触发）：空白前缀锚定
//     (?:^|\s)\/([^\s/]*)$（与 @/# 对称——句中空格后与 pill 折叠空格后均可
//     触发；无空白前导的 / 不触发）；命令组 ipc.session.listCommands，
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
//     在 RichComposer 内
//   - 菜单键盘导航（2026-09-26 可用性 P0）：三类菜单统一为跨组扁平条目，
//     ↑/↓ 循环移动高亮、Enter/Tab 选中、Esc 关闭（RichComposer onNavigate
//     裁决 + onEnter 让位）；菜单有条目时 Enter 不发送
//   - Kimi 式单一容器（v2.11.1 F3→v3）：RichComposer 无边框置于容器内，
//     框内底行仅剩 📎 左下角（chips 已由编辑器内联 pill 取代）
//   - 工具条选择按钮（2026-11-05 定案：零文本侵入 + 菜单内搜索）：InputToolbar
//     五按钮经 session.store mentionTrigger 触发——直开对应菜单类型
//     （agent/file/session→@ 统一菜单型、task→#、skill→/ 仅技能组），不向
//     输入框插入任何触发符（放弃选择零残留）；限定菜单顶部有独立搜索框
//     （scopeQuery，输入即过滤 + 键盘闭环），手动键入 @/#// 仍在会话框过滤
//     （query 路径不变）；scope 随菜单生命周期清空（选中/Esc/发送/切会话/
//     触发符失配），信号一次性消费防重挂载回放
//   - 文件导入（预览方案 A/C）：📎 转为直接导入按钮 + 文件限定菜单底部固定
//     「从电脑导入…」条目 + 拖拽泛化（onDropFiles 全文件路由）——同一管线：
//     图片扩展名走 image pill（降采样 + saveImage），其余 asset:importFile
//     复制进 imports/ 后插 file pill（id=相对路径进序列化、label=文件名显示）
import { Fragment, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Bot, EyeOff, FileText, Folder, Image as ImageIcon, Loader2, Lock, MessagesSquare, Paperclip, Pin, Terminal, Upload, Zap } from 'lucide-react';
import { useSessionStore, type MentionTriggerKind } from '../../stores/session.store';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { IconButton } from '../ui/IconButton';
import { RichComposer, type RichComposerHandle } from './RichComposer';
import {
  draftToSegments,
  segmentsToDraft,
  serializeSegments,
  type PillSeg,
} from './composer-segments';
import {
  downscaleImage,
  makeImagePill,
  IMAGE_MAX_EDGE,
  IMAGE_PER_MESSAGE_CAP,
} from '../../lib/image-downscale';
import type { SearchHit, SessionMemberInfo, SessionSummary, TaskRow, TaskStatus } from '../../ipc/types';

type MenuKind = 'agent' | 'task' | 'command';

/** 菜单条目分组（@ 菜单 agent+file+session 三组、/ 菜单 command+skill 双组、# 单组） */
type MenuGroup = 'agent' | 'file' | 'task' | 'command' | 'skill' | 'session';

/** 扁平菜单条目：键盘高亮索引在跨组单序列上移动（组头仅渲染分隔） */
interface MenuEntry {
  key: string;
  group: MenuGroup;
  primary: string;
  /** 命令描述等次级文本（truncate 三级色） */
  secondary?: string;
  /** agent 自定义 emoji（无则回落 lucide 组图标） */
  iconEmoji?: string;
  /** 图片扩展名文件条目（spec §5：lucide-image 图标 + 选中进 images 通道） */
  image?: boolean;
  /** 目录条目（2026-11-11 B 方案）：lucide-folder 图标 + 选中 = 钻入而非插 pill */
  isDirectory?: boolean;
  select: () => void;
}

const GROUP_LABEL: Record<MenuGroup, string> = {
  agent: '选择要 @ 的 agent',
  file: '引用文件',
  task: '选择要引用的任务',
  command: '命令',
  skill: '技能',
  // 跨会话引用（spec 2026-09-30 §5）——@ 菜单第三组「引用会话」，
  // 已加载会话列表排除当前会话后供选
  session: '引用会话',
};

/** 组图标（emoji 缺席时）；16px 语义 token 体系外的 12px 行内图标与旧三块菜单一致 */
function GroupIcon({ group, emoji }: { group: MenuGroup; emoji?: string }) {
  if (emoji) return <span>{emoji}</span>;
  switch (group) {
    case 'agent':
      return <Bot size={12} strokeWidth={1.75} aria-hidden />;
    case 'file':
      return <FileText size={12} strokeWidth={1.75} aria-hidden />;
    case 'task':
      return <Pin size={12} strokeWidth={1.75} aria-hidden />;
    case 'command':
      return <Terminal size={12} strokeWidth={1.75} aria-hidden />;
    case 'skill':
      return <Zap size={12} strokeWidth={1.75} aria-hidden />;
    case 'session':
      return <MessagesSquare size={12} strokeWidth={1.75} aria-hidden />;
  }
}

/** # 菜单仅展示可激活态（v2.3：store 全量拉取后此过滤成为唯一防线） */
const MENU_STATUSES: ReadonlyArray<TaskStatus> = ['draft', 'pending', 'assigned'];
/** 菜单最多展示条目数（pending 任务可能较多） */
const MENU_LIMIT = 10;
/** @ 统一菜单文件组最多展示条目数（searchNames 命中与 file.list 根目录默认列表共用此上限，renderer 端截取） */
const FILE_MENU_LIMIT = 8;
/** @ 菜单会话组最多展示条目数（会话列表通常较长，与文件组限额同量级；spec 2026-09-30 §5） */
const SESSION_MENU_LIMIT = 8;

/**
 * 按钮限定菜单的数据上限（2026-11-05 实测修订）：手动过滤菜单是「打字快速
 * 选择」，短列表合理；按钮限定菜单是小白的主浏览器——只受此防御性上限
 * （菜单本体 max-h-48 滚动承载），不受手动路径的 8/10 条截断。
 */
const SCOPED_MENU_LIMIT = 100;
/** / 菜单命令组 / 技能组各自最多展示条目数（与 @ 菜单分组限额对齐） */
const COMMAND_MENU_LIMIT = 8;
/** 文件搜索防抖间隔（毫秒），与 FileTree 的 SEARCH_DEBOUNCE_MS 对齐 */
const FILE_SEARCH_DEBOUNCE_MS = 200;
/**
 * @ 菜单图片分流判定（spec §5）：命中扩展名的文件条目走 image 通道
 * （lucide-image 图标 + 选中插 image pill），其余照旧 file 通道。
 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** 内联图片提示自动消失间隔（毫秒） */
const IMAGE_HINT_TIMEOUT_MS = 4000;

/**
 * scope 对应菜单类型（按钮直开 + detectTrigger 失配判定共用：键入的触发符
 * 与 scope 不符即结束限定）
 */
const SCOPE_MENU_TYPE: Record<MentionTriggerKind, MenuKind> = {
  agent: 'agent',
  file: 'agent',
  session: 'agent',
  task: 'task',
  skill: 'command',
};

/** scope 限定菜单的空态文案（预览合同 ② 卡2：按钮点击必须有可感知反馈） */
const SCOPE_EMPTY: Record<MentionTriggerKind, { p1: string; p2: string }> = {
  agent: { p1: '暂无在线 agent', p2: '在「成员」面板启动 agent 后即可引用' },
  skill: { p1: '暂未安装技能', p2: '可在资源库安装技能后引用' },
  file: { p1: '工作空间暂无文件', p2: '可从电脑导入' },
  session: { p1: '暂无其他会话', p2: '切换或新建会话后即可引用' },
  task: { p1: '暂无可引用的任务', p2: '仅 draft / pending / assigned 状态可引用' },
};

/** 按钮限定菜单内搜索框的占位文案 */
const SCOPE_SEARCH_PLACEHOLDER: Record<MentionTriggerKind, string> = {
  agent: '搜索 agent',
  skill: '搜索技能',
  file: '搜索文件',
  session: '搜索会话',
  task: '搜索任务',
};

/** 菜单内搜索无命中的空态（与组空态区分——有数据但关键词不中） */
const noMatchHint = (q: string): { p1: string; p2: string } => ({
  p1: `无匹配「${q}」`,
  p2: '换个关键词试试',
});

/** 导入单文件上限：与主进程 asset-ipc.ts MAX_IMPORT_BYTES 同值（注释互指，改必两处） */
const IMPORT_MAX_BYTES = 64 * 1024 * 1024;

/** pending 已耗时（秒）：active 上升沿复位归零，1s tick 给「仍在执行」信号 */
function useElapsedSeconds(active: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) return;
    setSec(0);
    const start = Date.now();
    const timer = setInterval(() => {
      setSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);
  return sec;
}

export function MentionInput() {
  const [menuType, setMenuType] = useState<MenuKind | null>(null);
  const [query, setQuery] = useState('');
  // 按钮限定菜单的菜单内搜索词（2026-11-05 用户定案）：手动路径在会话框键入
  // 过滤（query，不变）；按钮菜单顶部有独立搜索框（scopeQuery），输入即过滤
  const [scopeQuery, setScopeQuery] = useState('');
  // 菜单键盘导航高亮索引（跨组扁平序列；query/菜单类型变化回顶，条目缩水渲染期 clamp）
  const [activeIndex, setActiveIndex] = useState(0);
  const menuListRef = useRef<HTMLDivElement>(null);
  const scopeSearchRef = useRef<HTMLInputElement>(null);
  // 文件组命中（@ 菜单双源之一；空 query 显示 ipc.file.list('.') 根目录默认列表，
  // 非空 query debounce 200ms 调 searchNames；统一过滤目录 + 截 FILE_MENU_LIMIT）
  const [fileHits, setFileHits] = useState<SearchHit[]>([]);
  // 主进程遍历预算提前结束（2026-11-11 方案 C）：结果可能不完整，菜单底部示警。
  // 与「结果数达上限」区分——后者是正常截断，不提示。
  const [fileTruncated, setFileTruncated] = useState(false);
  // 文件搜索竞态守卫：响应返回时序号不匹配则丢弃（与 FileTree 一致）
  const fileSearchSeqRef = useRef(0);
  // / 菜单两组数据缓存：命令注册表 + 已安装技能（挂载时拉取一次，均为全局
  // 数据不随会话切换；失败静默——菜单数据缺失不阻塞输入）
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [skillItems, setSkillItems] = useState<Array<{ slug: string; name: string }>>([]);
  const composerRef = useRef<RichComposerHandle>(null);
  // 图片管线内联提示（上限拦截 / downscale·saveImage 失败）与能力提示行的
  // pill 存在标记（spec §8 场景 1）。imageHint 定时自动消失（transient）
  const [imageHint, setImageHint] = useState<{ kind: 'warn' | 'error'; msg: string } | null>(null);
  const imageHintTimerRef = useRef<number | null>(null);
  const [hasImagePill, setHasImagePill] = useState(false);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const members = useSessionStore((s) => s.members);
  // 已加载会话列表（@ 菜单会话组数据源；store 加载 = 切会话 / 启动时拉取一次，
  // 跨会话引用无需新 IPC——切到任意会话时 sessions 已在内存）
  const sessions = useSessionStore((s) => s.sessions);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  // 只读态（有效成员全失效，spec §7）与聚焦信号（新建会话后聚焦，spec §6.2）
  const readOnly = useSessionStore((s) => s.activeSessionReadOnly);
  // 委派跟踪只读态（T23）：活动会话 summary.readOnly（= delegationRole 'out'，
  // P1 唯一只读源）——输入区整体替换为只读占位，用户操作收敛到请求面板/验收流
  const trackingReadOnly = useSessionStore((s) =>
    s.activeSessionId == null
      ? false
      : (s.sessions.find((x) => x.id === s.activeSessionId)?.readOnly ?? false),
  );
  const inputFocusTick = useSessionStore((s) => s.inputFocusTick);
  // 工具条选择按钮触发信号（2026-11-05）：InputToolbar 五按钮 bump
  const mentionTrigger = useSessionStore((s) => s.mentionTrigger);
  // 按钮限定菜单的组：null=手动键入统一菜单（路径不变）
  const mentionScope = useSessionStore((s) => s.mentionScope);
  const closeMentionScope = useSessionStore((s) => s.closeMentionScope);
  // 斜杠命令提示（spec §5.4）：成功 message 或失败 Error.message；下一次正常
  // 发消息时 store 自动置 null
  const commandHint = useSessionStore((s) => s.commandHint);
  // 命令执行中（按会话键控）：pending 期间显示进度提示并禁用发送（防压缩中
  // 并发开新回合破坏「摘要下轮生效」语义）
  const commandPending = useSessionStore((s) =>
    s.activeSessionId ? s.commandPendingBySession.get(s.activeSessionId) : undefined,
  );
  const pendingElapsed = useElapsedSeconds(commandPending !== undefined);
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
    setScopeQuery('');
    closeMentionScope();
    // 跨 workspace 陈旧命中防闪现（终审 M1）：menuType 同步置 null 后文件 effect
    // 会跳过分支不清 fileHits；切会话时显式清空，下一次 @ 触发前菜单条件
    // (filteredMembers.length > 0 || fileHits.length > 0) 不会拿旧 ws 数据渲染
    setFileHits([]);
    setFileTruncated(false);
    syncImageHint();
    prevSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  // @ 统一菜单文件组。手动路径：空 query → file.list('.') 根目录默认列表，
  // 非空 → debounce searchNames。按钮限定（scope='file'）：菜单内搜索框
  // scopeQuery 驱动——空 → searchNames('') match-all 全量递归，非空 →
  // debounce searchNames。seqRef 竞态守卫覆盖全部路径；truncated（主进程
  // 遍历预算耗尽）原样透传给菜单示警（2026-11-11 方案 C）。
  const workspaceId = workspace?.id;
  useEffect(() => {
    if (menuType !== 'agent') {
      fileSearchSeqRef.current++;
      setFileTruncated(false);
      return;
    }
    if (!workspaceId) return;
    const scoped = mentionScope === 'file';
    const trimmed = (scoped ? scopeQuery : query).trim();
    const fileLimit = scoped ? SCOPED_MENU_LIMIT : FILE_MENU_LIMIT;
    if (trimmed === '') {
      const seq = ++fileSearchSeqRef.current;
      if (mentionScope === 'file') {
        void ipc.file
          .searchNames(workspaceId, '')
          .then((res) => {
            if (fileSearchSeqRef.current !== seq) return;
            setFileHits(res.hits.slice(0, fileLimit));
            setFileTruncated(res.truncated);
          })
          .catch(() => {
            if (fileSearchSeqRef.current !== seq) return;
            setFileHits((prev) => (prev.length > 0 ? [] : prev));
            setFileTruncated(false);
          });
        return;
      }
      // 根目录默认列表是一次 readdir，不存在遍历预算截断
      setFileTruncated(false);
      void ipc.file
        .list(workspaceId, '.')
        .then((entries) => {
          if (fileSearchSeqRef.current !== seq) return;
          setFileHits(
            entries
              .filter((e) => !e.isDirectory)
              .slice(0, fileLimit)
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
        .then((res) => {
          if (fileSearchSeqRef.current !== seq) return;
          setFileHits(res.hits.slice(0, fileLimit));
          setFileTruncated(res.truncated);
        })
        .catch(() => {
          if (fileSearchSeqRef.current !== seq) return;
          setFileHits((prev) => (prev.length > 0 ? [] : prev));
          setFileTruncated(false);
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [menuType, query, scopeQuery, workspaceId, mentionScope]);

  // # 菜单数据接线：task.store 此前仅 TaskBoardView 加载，IM 视图挂载时
  // 主动拉取当前 workspace 的任务（可激活态过滤由上方 MENU_STATUSES 承载）
  useEffect(() => {
    if (workspace) void loadTasks(workspace.id);
  }, [workspace, loadTasks]);

  // / 菜单数据接线：命令组 + 技能组并行拉取缓存（不走 store——store 的
  // typeFilter 是资源库页面的 tab 全局态，此处需要固定 { type: 'skill' } 视图）
  useEffect(() => {
    void ipc.session.listCommands().then(setCommands).catch(() => {});
    // 技能组按活动 ws 拉取并滤停用插件行（矩阵 C4：/ 引用入口=全熄语义——
    // 停用插件的 skill 不进菜单；无 ws 语境退化为不标注不过滤）
    void ipc.resource
      .list({ type: 'skill', workspaceId: workspace?.id })
      .then((items) =>
        setSkillItems(
          items
            .filter((i) => i.installed && !i.pluginDisabled)
            .map((i) => ({ slug: i.slug, name: i.name })),
        ),
      )
      .catch(() => {});
  }, [workspace?.id]);

  // 生效过滤词（2026-11-05 双路定案）：手动路径消费编辑器 query（键入即过滤）；
  // 按钮限定菜单消费菜单内搜索框的 scopeQuery
  const effQuery = mentionScope === null ? query : scopeQuery;

  // 在线成员判定与 MembersPanel 同源：lastRunning = 用户最近运行意图。
  // 上限分路（2026-11-05）：手动过滤维持 MENU_LIMIT 短列表；按钮限定菜单
  // （scope='agent'）= 完整浏览器语义，SCOPED_MENU_LIMIT 承载
  const filteredMembers =
    menuType === 'agent'
      ? members
          .filter((m) => m.lastRunning)
          .filter((m) => {
            if (!effQuery) return true;
            return m.agentName.toLowerCase().includes(effQuery.toLowerCase());
          })
          .slice(0, mentionScope === 'agent' ? SCOPED_MENU_LIMIT : MENU_LIMIT)
      : [];

  const filteredTasks =
    menuType === 'task'
      ? tasks
          .filter(
            (t) =>
              MENU_STATUSES.includes(t.status) &&
              (!effQuery ||
                t.id.toLowerCase().includes(effQuery.toLowerCase()) ||
                t.title.toLowerCase().includes(effQuery.toLowerCase())),
          )
          .slice(0, mentionScope === 'task' ? SCOPED_MENU_LIMIT : MENU_LIMIT)
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
              !effQuery ||
              s.slug.toLowerCase().includes(effQuery.toLowerCase()) ||
              s.name.toLowerCase().includes(effQuery.toLowerCase()),
          )
          .slice(0, mentionScope === 'skill' ? SCOPED_MENU_LIMIT : COMMAND_MENU_LIMIT)
      : [];

  // @ 菜单会话组（跨会话引用 spec 2026-09-30 §5）：
  //   - 排除当前会话（读自己无意义）
  //   - 标题子串过滤（与其它组同形态，零额外 IPC）
  //   - 手动路径 SESSION_MENU_LIMIT 截取；按钮限定菜单 SCOPED_MENU_LIMIT
  const filteredSessions: SessionSummary[] =
    menuType === 'agent'
      ? sessions
          .filter((s) => s.id !== activeSessionId)
          .filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()))
          .slice(0, mentionScope === 'session' ? SCOPED_MENU_LIMIT : SESSION_MENU_LIMIT)
      : [];

  /**
   * 光标前缀触发检测（RichComposer onInputText 的 beforeCaret——pill 已折叠
   * 为单空格、剥 ZWSP）：/ 接命令与技能局部 / @ 接 slug 与文件路径局部
   * （统一菜单）/ # 接 T-数字局部。三触发同用空白前缀锚定 `(?:^|\s)`
   * （v3.1：句中 / 与 @/# 对称触发，主机反馈）——pill 折叠空格天然充当
   * 前导空白，pill 之后同样可触发。
   */
  const detectTrigger = (before: string): void => {
    // 命令分支在最前并短路返回（Task 8 教训：新分支不短路会落入后续 else
    // 清空 menuType）。空白前缀锚定：仅行首或空白后的 / 触发——无空白前导
    // 的 /（路径 src/文件、24/7、and/or、URL）不命中；'//' 转义（第二个 /
    // 不在 [^\s/] 字符集）不命中，strip 语义在 session.store.sendMessage，
    // 菜单不越权。字符集 [^\s/]——支持中文命令/技能名过滤。命令整串拦截
    // 语义不受影响：store 侧只拦纯命令 body（/^\/([A-Za-z0-9-]+)\s*$/），
    // 句中选命令 pill 序列化为混排正文按普通消息发送（spec §3）。
    const cmdMatch = before.match(/(?:^|\s)\/([^\s/]*)$/);
    // 字符集 [^\s#]（非空白且非 #）——支持中文 agent 名过滤，含 '/' 是
    // 统一菜单的前置条件（selectFile 复插 @路径 局部）
    const atMatch = before.match(/(?:^|\s)@([^\s#]*)$/);
    // 字符集 [^\s@]（非空白且非 @）——支持中文任务标题过滤
    const taskMatch = before.match(/(?:^|\s)#([^\s@]*)$/);
    // 优先级 cmd > at > task（cmd 命中即短路——Task 8 教训：新分支不短路会
    // 落入后续 else 清空 menuType）
    let next: MenuKind | null = null;
    let q = '';
    if (cmdMatch) {
      next = 'command';
      q = cmdMatch[1] ?? '';
    } else if (atMatch) {
      next = 'agent';
      q = atMatch[1] ?? '';
    } else if (taskMatch) {
      next = 'task';
      q = taskMatch[1] ?? '';
    }
    setMenuType(next);
    setQuery(q);
    // scope 生命周期（2026-11-05）：触发符消失或菜单类型失配（scope=agent 却
    // 键入 #）→ 结束限定；同菜单类型（含 scope=skill 的 /）保留——按钮限定
    // 期间的键入过滤不误杀。工具条触发路径：bump 已置 scope，insertTextAtEnd
    // 派发本函数走同类型分支，scope 保留到菜单自然关闭。
    if (mentionScope !== null && (next === null || SCOPE_MENU_TYPE[mentionScope] !== next)) {
      closeMentionScope();
    }
    // 能力提示行随 pill 增删刷新：input 事件 + RichComposer removePill 的补发
    // onInputText 都汇入此处（pill 删除无原生 input 事件——RichComposer 侧补发）
    syncImageHint();
  };

  /**
   * 能力提示行数据源：编辑器内是否存在 image pill。仅在值变化时 setState
   * （同值 bail out——不给每次键入加渲染）。pill 变更点（粘贴插入 / @ 选择 /
   * 发送清空 / 失败恢复 / 草稿切换 / input 补发）统一调本函数。
   */
  const syncImageHint = (): void => {
    const has = (composerRef.current?.getSegments() ?? []).some(
      (s) => s.type === 'pill' && s.kind === 'image',
    );
    setHasImagePill((prev) => (prev === has ? prev : has));
  };

  /** 内联图片提示（transient：超时自动消失；新提示覆盖旧计时器） */
  const showImageHint = (kind: 'warn' | 'error', msg: string): void => {
    setImageHint({ kind, msg });
    if (imageHintTimerRef.current !== null) window.clearTimeout(imageHintTimerRef.current);
    imageHintTimerRef.current = window.setTimeout(() => setImageHint(null), IMAGE_HINT_TIMEOUT_MS);
  };

  useEffect(
    () => () => {
      if (imageHintTimerRef.current !== null) window.clearTimeout(imageHintTimerRef.current);
    },
    [],
  );

  /** 当前编辑器内 image pill 数（上限拦截判定） */
  const countImagePills = (): number =>
    (composerRef.current?.getSegments() ?? []).filter(
      (s) => s.type === 'pill' && s.kind === 'image',
    ).length;

  /**
   * 粘贴/拖入图片管线（spec §5/§10）：上限拦截（编辑器内 image pill 现值 +
   * 新增 ≤6）→ 逐张 downscale → asset:saveImage → insertPill（粘贴无触发
   * 局部，replaceLen 0）。任一张失败：内联 error 提示 + 不插 pill，其余张
   * 继续（spec §11：输入不受影响）。逐张 await 串行保插入顺序与粘贴一致。
   * 上限判定每轮迭代两查（Task 9 fold-in b）——downscale 前快查（已满即拒，
   * 零无谓开销）+ insertPill 前权威复查：两批并发粘贴在途时快查各见余量，
   * 唯有插入点现值判定能拦住跨批的第 7 张（输家浪费一次 downscale，可接受）。
   */
  const handlePasteImages = async (files: File[]): Promise<void> => {
    if (countImagePills() >= IMAGE_PER_MESSAGE_CAP) {
      showImageHint('warn', `最多 ${IMAGE_PER_MESSAGE_CAP} 张图片`);
      return;
    }
    for (const file of files) {
      if (countImagePills() >= IMAGE_PER_MESSAGE_CAP) {
        showImageHint('warn', `最多 ${IMAGE_PER_MESSAGE_CAP} 张图片`);
        break;
      }
      try {
        const img = await downscaleImage(file);
        if (!workspaceId) return;
        const { path } = await ipc.asset.saveImage(workspaceId, img.data, img.ext);
        // 权威复查：await 让出期间并发批次可能已把 pill 数推到上限
        if (countImagePills() >= IMAGE_PER_MESSAGE_CAP) {
          showImageHint('warn', `最多 ${IMAGE_PER_MESSAGE_CAP} 张图片`);
          break;
        }
        composerRef.current?.insertPill(makeImagePill(path, img.w, img.h, file.name), 0);
        syncImageHint();
      } catch (err) {
        showImageHint('error', err instanceof Error ? err.message : String(err));
      }
    }
  };

  /**
   * 外部文件导入管线（2026-11-05 预览方案 A/C；📎 按钮 / 文件菜单固定条目 /
   * 拖拽三入口共用）：图片扩展名分流进 handlePasteImages（降采样 + saveImage
   * 的 image pill 通道），其余 asset:importFile 复制进 imports/ 后插 file pill
   * （id=相对路径进 body `@路径` 与 context.files；label=文件名仅显示——序列
   * 化契约见 composer-segments）。逐张 await 串行保插入顺序；单张失败内联
   * 提示不中断其余（与图片管线 spec §11 同语义）。
   */
  const importExternalFiles = async (files: File[]): Promise<void> => {
    const images = files.filter((f) => IMAGE_EXT_RE.test(f.name));
    const others = files.filter((f) => !IMAGE_EXT_RE.test(f.name));
    if (images.length > 0) await handlePasteImages(images);
    for (const f of others) {
      try {
        if (f.size > IMPORT_MAX_BYTES) {
          showImageHint('warn', `「${f.name}」超过 64MB 上限，未导入`);
          continue;
        }
        if (!workspaceId) return;
        const data = new Uint8Array(await f.arrayBuffer());
        const { path } = await ipc.asset.importFile(workspaceId, data, f.name);
        resetIfDirtyEmpty();
        composerRef.current?.insertPill({ type: 'pill', kind: 'file', id: path, label: f.name }, 0);
        composerRef.current?.focus();
        syncImageHint();
      } catch (err) {
        showImageHint('error', `「${f.name}」导入失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // 系统文件选择器入口（hidden input，多选；change 后复位 value 允许重选同文件）
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openImportPicker = (): void => {
    if (!activeSessionId || readOnly) return;
    fileInputRef.current?.click();
  };
  const handleImportChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    void importExternalFiles(files);
  };

  // 拖拽悬停态（2026-11-05 预览 ③ 卡B）：dragenter/leave 计数法防子元素抖动；
  // drop/dragend 复位。overlay 置 pointer-events-none——drop 事件仍落在编辑器
  // （RichComposer onDropFiles 管线），此处只管视觉
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const hasFiles = (dt: DataTransfer | null): boolean =>
    dt !== null && Array.from(dt.types).includes('Files');
  const endDragVisual = (): void => {
    dragDepthRef.current = 0;
    setDragOver(false);
  };

  // 工具条选择按钮触发（2026-11-05；零文本侵入 + 一次性信号 + 菜单内搜索）：
  // mentionTrigger 变更 → 复位搜索词 + 直接置对应菜单类型（mentionScope 已由
  // bump 同步置位），消费完立即 consumeMentionTrigger 清空——否则面板切走时
  // 组件卸载、信号滞留 store，切回会话重挂载时 effect 在 mount 再消费同一
  // 信号 → 菜单自动弹出（实测 bug 3）。焦点不抢编辑器：菜单内搜索框
  // （autoFocus）承接，输入即过滤；键盘闭环在搜索框 onKeyDown。旧菜单让位
  // 语义保留：跨类型 bump 直接覆盖 menuType。
  useEffect(() => {
    if (mentionTrigger === null) return;
    setScopeQuery('');
    setMenuType(SCOPE_MENU_TYPE[mentionTrigger.kind]);
    useSessionStore.getState().consumeMentionTrigger();
  }, [mentionTrigger]);

  // 卸载（面板切走）时菜单随之消亡：清 scope，防工具条高亮与重挂载后限定态
  // 残留（触发信号已被上面的消费语义清空，无需此处处理）
  useEffect(() => {
    return () => {
      useSessionStore.getState().closeMentionScope();
    };
  }, []);

  /**
   * 菜单选择统一形：把光标前的触发局部（sigil + 查询词，共
   * `1 + query.length` 字符）替换为原子 pill。insertPill 是静默的（不触发
   * onInputText）——必须显式关菜单清 query，并同步能力提示行。
   */
  /**
   * 程序化插入前的脏 DOM 守门（实测 bug 4）：输入过再清空后 Chromium 常残留
   * <br>/空节点，末尾追加型插入（按钮选中/导入）会落在残留节点后 = 跳行。
   * segments 为空（无 pill 无正文）时先复位纯净再追加。输入路径的自愈在
   * RichComposer handleInput（placeholder 回归同源问题）。
   */
  const resetIfDirtyEmpty = (): void => {
    const segs = composerRef.current?.getSegments() ?? [];
    const hasContent = segs.some((s) => s.type === 'pill' || (s.type === 'text' && s.text.trim() !== ''));
    if (!hasContent) composerRef.current?.clear();
  };

  const selectWithPill = (pill: Omit<PillSeg, 'type'>): void => {
    if (mentionScope !== null) {
      // 按钮限定菜单：输入框无触发符局部可替换——pill 追加到末尾（按钮流无
      // 用户光标上下文，末尾追加最可预期；replaceLen 0 = 不吞任何正文）
      resetIfDirtyEmpty();
      composerRef.current?.moveCaretToEnd();
      composerRef.current?.insertPill({ type: 'pill', ...pill }, 0);
    } else {
      composerRef.current?.insertPill({ type: 'pill', ...pill }, 1 + query.length);
    }
    // 菜单 button 的 mousedown 偷走焦点（v2.11.1 insertMention 同款问题）——
    // 选择后显式恢复，否则键盘输入落空。insertPill 已设好 selection，focus
    // 保留元素内既有选区；手动路径勿用 moveCaretToEnd——中段插入场景会错跳末尾
    composerRef.current?.focus();
    setMenuType(null);
    setQuery('');
    setScopeQuery('');
    closeMentionScope();
    syncImageHint();
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

  /**
   * 文件选择：与 agent 同形（id = 文件路径）；图片扩展名分流进 image 通道
   * （spec §5）。选择时只有路径没有 File——renderer 无法解码取真实尺寸，
   * 落 2048×2048 上界哨兵：sanitize 要求正整数 w/h，2048 是降采样上限，
   * token 估算（⌈2048²/750⌉ = 5593）只会高估不会漏算，LLM 侧拿到的是真图。
   * 已知取舍：@ 图片估算偏保守，Task 9/final review 可评估主进程 expand 时
   * 重读真实尺寸的方案。
   */
  const selectFile = (f: SearchHit): void => {
    if (IMAGE_EXT_RE.test(f.path)) {
      if (countImagePills() >= IMAGE_PER_MESSAGE_CAP) {
        showImageHint('warn', `最多 ${IMAGE_PER_MESSAGE_CAP} 张图片`);
        setMenuType(null);
        setQuery('');
        return;
      }
      selectWithPill(makeImagePill(f.path, IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, f.path));
      return;
    }
    selectWithPill({ kind: 'file', id: f.path, label: f.path });
  };

  /**
   * 目录钻入（2026-11-11 B 方案）：目录不进正文（context 只认文件）——把查询
   * 改写为 `dir/` 就地展开其内容，主进程路径匹配随即只列该目录子项，用户继续
   * 输入即可收窄到文件。按钮限定菜单改菜单内搜索词；手动 @ 走编辑器触发局部
   * 文本替换（`@shell` → `@shell/`），菜单保持打开。
   */
  const drillIntoDir = (path: string): void => {
    const next = `${path}/`;
    if (mentionScope === 'file') {
      setScopeQuery(next);
      scopeSearchRef.current?.focus();
      return;
    }
    composerRef.current?.replaceBeforeCaret(1 + query.length, `@${next}`);
    composerRef.current?.focus();
  };

  /** 按菜单类型聚合的原始条目（scope 过滤前；三分支就地填充） */
  const rawEntries: MenuEntry[] = [];
  if (menuType === 'agent') {
    for (const m of filteredMembers) {
      rawEntries.push({
        key: `agent:${m.instanceId}`,
        group: 'agent',
        primary: m.agentName,
        iconEmoji: m.iconEmoji ?? undefined,
        select: () => selectMember(m),
      });
    }
    for (const f of fileHits) {
      rawEntries.push({
        key: `file:${f.path}`,
        group: 'file',
        primary: f.path,
        image: !f.isDirectory && IMAGE_EXT_RE.test(f.path),
        isDirectory: f.isDirectory,
        select: () => (f.isDirectory ? drillIntoDir(f.path) : selectFile(f)),
      });
    }
    // 会话组追加在 file 之后（spec agent → file → session 顺序）——
    // 选 session pill 走 selectWithPill，复用 replaceLen 局部替换 + focus 恢复
    for (const s of filteredSessions) {
      rawEntries.push({
        key: `session:${s.id}`,
        group: 'session',
        primary: s.title,
        select: () => selectWithPill({ kind: 'session', id: s.id, label: s.title }),
      });
    }
  } else if (menuType === 'task') {
    for (const t of filteredTasks) {
      rawEntries.push({
        key: `task:${t.id}`,
        group: 'task',
        primary: `#${t.id} · ${t.title}`,
        select: () => selectTask(t),
      });
    }
  } else if (menuType === 'command') {
    for (const c of filteredCommands) {
      rawEntries.push({
        key: `command:${c.name}`,
        group: 'command',
        primary: `/${c.name}`,
        secondary: c.description,
        select: () => selectCommand(c.name),
      });
    }
    for (const s of filteredSkills) {
      rawEntries.push({ key: `skill:${s.slug}`, group: 'skill', primary: s.name, select: () => selectSkill(s) });
    }
  }
  // 工具条按钮限定（2026-11-05 预览合同「一个按钮一件事」）：scope 非空 →
  // 过滤至单组；手动键入（scope=null）统一菜单不变。渲染与键盘导航消费过滤后序列
  const menuEntries: MenuEntry[] =
    mentionScope === null ? rawEntries : rawEntries.filter((e) => e.group === mentionScope);
  // 文件限定菜单底部固定「从电脑导入…」条目（预览 ② 卡3：不随 query 过滤隐藏，
  // 分隔线隔开）。刻意不进 menuEntries：键盘导航圈保持纯数据条目，导入是动作
  // 入口（该按钮自身可 Tab 聚焦，鼠标为主路径）
  const pinnedImportVisible = mentionScope === 'file' && menuType === 'agent';
  // 空态行分路（预览 ② 卡2 + 菜单内搜索）：搜索词非空且零命中 → 「无匹配」
  // （有数据但关键词不中）；搜索词空 → 组空态（真的没有数据）。file 组看真实
  // 文件命中（pinned 不算数）
  const scopedEmptyHint = (() => {
    if (mentionScope === null) return null;
    const q = scopeQuery.trim();
    if (mentionScope === 'file') {
      if (fileHits.length > 0) return null;
      // 遍历预算耗尽时「无匹配」是未扫描完的结论，必须换措辞（2026-11-11 方案 C）
      if (fileTruncated) {
        return {
          p1: q === '' ? '文件过多，本次仅扫描了部分目录' : `未在已扫描范围内找到「${q}」`,
          p2: '扫描已达上限，请输入更具体的关键词',
        };
      }
      return q === '' ? SCOPE_EMPTY.file : noMatchHint(q);
    }
    if (menuEntries.length > 0) return null;
    return q === '' ? SCOPE_EMPTY[mentionScope] : noMatchHint(q);
  })();
  const menuOpen =
    menuEntries.length > 0 || scopedEmptyHint !== null || pinnedImportVisible;
  // 文件命中异步到达会缩列表：clamp 防越界（高亮粘到末条）
  const activeIdx = menuEntries.length === 0 ? 0 : Math.min(activeIndex, menuEntries.length - 1);

  // 过滤词/菜单类型变化 → 高亮回顶（新序列语义上已是另一份列表）
  useEffect(() => {
    setActiveIndex(0);
  }, [menuType, query, scopeQuery]);

  // 高亮项滚入视野（jsdom 无 scrollIntoView——optional call 守卫）
  useEffect(() => {
    menuListRef.current
      ?.querySelector<HTMLElement>('[data-active="1"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx, menuOpen]);

  const selectActive = (): void => {
    menuEntries[activeIdx]?.select();
  };

  /** RichComposer onNavigate 裁决：菜单开 = ↑↓ 移动 / Tab 选中（消费），否则放行编辑器默认 */
  const handleNavigate = (key: 'ArrowUp' | 'ArrowDown' | 'Tab'): boolean => {
    if (!menuOpen) return false;
    if (key === 'Tab') {
      selectActive();
      return true;
    }
    const len = menuEntries.length;
    setActiveIndex(key === 'ArrowDown' ? (activeIdx + 1) % len : (activeIdx - 1 + len) % len);
    return true;
  };

  /**
   * 菜单内搜索框键盘闭环（2026-11-05 用户定案）：↑↓ 循环高亮 / Enter·Tab
   * 选中 / Esc 关闭并焦点交还编辑器。IME 组字期不误触发（isComposing 守卫）。
   */
  const handleScopeSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const len = menuEntries.length;
      if (len === 0) return;
      setActiveIndex(e.key === 'ArrowDown' ? (activeIdx + 1) % len : (activeIdx - 1 + len) % len);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectActive();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setMenuType(null);
      setQuery('');
      setScopeQuery('');
      closeMentionScope();
      composerRef.current?.focus();
    }
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
    // 命令执行中（如 /compact 的 LLM 摘要调用）禁发——并发开新回合会破坏
    // 「摘要下轮生效」语义；pending 提示条已向用户说明原因
    if (commandPending !== undefined) return;
    composerRef.current?.clear();
    syncImageHint();
    setMenuType(null);
    setQuery('');
    setScopeQuery('');
    closeMentionScope();
    try {
      await sendMessage(trimmed, payload.mentions, payload.context);
      await loadSessions();
    } catch {
      // 发送失败恢复：pill 原位 + 正文保留（setSegments 快照），用户可修改后重发
      composerRef.current?.setSegments(segs);
      syncImageHint();
    }
  };

  return (
    <div className="border-t border-subtle bg-surface-1 p-3 relative">
      {/* 统一菜单（@ = agent+文件 / # = 任务 / = 命令+技能）：跨组扁平序列，
          组头分隔；键盘高亮 data-active，hover 同步索引 */}
      {menuOpen && (
        <div
          ref={menuListRef}
          className="absolute bottom-full left-3 right-3 mb-1 border border-subtle bg-surface-1 rounded-lg shadow-lg py-1 max-h-48 overflow-auto z-50"
        >
          {mentionScope !== null && (
            <div className="px-2.5 py-1.5 border-b border-subtle sticky top-0 bg-surface-1">
              <input
                ref={scopeSearchRef}
                autoFocus
                data-testid="scope-search"
                type="text"
                value={scopeQuery}
                onChange={(e) => setScopeQuery(e.target.value)}
                onKeyDown={handleScopeSearchKeyDown}
                placeholder={SCOPE_SEARCH_PLACEHOLDER[mentionScope]}
                aria-label={SCOPE_SEARCH_PLACEHOLDER[mentionScope]}
                className="w-full text-sm bg-surface-2 border border-subtle rounded px-2 py-1.5 text-primary placeholder:text-tertiary focus:outline-none focus:border-focus"
              />
            </div>
          )}
          {scopedEmptyHint !== null && mentionScope !== null && (
            <Fragment>
              <div className="px-3 py-1 text-xs text-tertiary">{GROUP_LABEL[mentionScope]}</div>
              <div className="px-3 py-1.5 text-sm text-secondary">{scopedEmptyHint.p1}</div>
              <div className="px-3 pb-2 pl-10 -mt-1 text-xs text-tertiary">{scopedEmptyHint.p2}</div>
            </Fragment>
          )}
          {menuEntries.map((entry, i) => (
            <Fragment key={entry.key}>
              {(i === 0 || menuEntries[i - 1]?.group !== entry.group) && (
                <div className="px-3 py-1 text-xs text-tertiary">{GROUP_LABEL[entry.group]}</div>
              )}
              <button
                type="button"
                data-active={i === activeIdx ? '1' : undefined}
                onClick={entry.select}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2${
                  i === activeIdx ? ' bg-surface-active' : ''
                }`}
              >
                <span className="shrink-0">
                  {entry.isDirectory ? (
                    <Folder size={12} strokeWidth={1.75} aria-hidden />
                  ) : entry.image ? (
                    <ImageIcon size={12} strokeWidth={1.75} aria-hidden />
                  ) : (
                    <GroupIcon group={entry.group} emoji={entry.iconEmoji} />
                  )}
                </span>
                <span className="truncate">{entry.primary}</span>
                {entry.secondary !== undefined && (
                  <span className="truncate text-tertiary">{entry.secondary}</span>
                )}
              </button>
            </Fragment>
          ))}
          {/* 遍历预算耗尽（方案 C）：结果不完整必须可见，否则又是「搜不到 = 没有」误解 */}
          {fileTruncated && menuEntries.length > 0 && (
            <div className="px-3 py-1 text-xs text-status-warning border-t border-subtle">
              扫描已达上限，结果可能不完整——输入更具体的关键词
            </div>
          )}
          {pinnedImportVisible && (
            <div className="border-t border-subtle mt-1">
              <button
                type="button"
                onClick={openImportPicker}
                className="w-full text-left px-3 py-2 text-sm hover:bg-surface-3 flex items-center gap-2 text-secondary"
              >
                <Upload size={12} strokeWidth={1.75} aria-hidden />
                <span>从电脑导入…</span>
                <span className="text-xs text-tertiary">复制进 imports/ 后引用</span>
              </button>
            </div>
          )}
        </div>
      )}

      {readOnly && (
        <div className="mb-2 text-xs text-tertiary inline-flex items-center gap-1">
          <Lock size={12} strokeWidth={1.75} aria-hidden className="inline-block align-[-1px]" />
          <span>会话成员已全部移出，会话只读（历史可查看）</span>
        </div>
      )}

      {commandPending !== undefined && (
        <div className="mb-2 flex justify-center" data-testid="command-pending-hint">
          {/* 与 CompactNotice 结果卡同族的居中进度卡（pending ↔ result 对称）：
              主行 + 已耗时计时器给「还活着」信号，副行说明耗时预期与发送暂停 */}
          <div className="inline-flex flex-col gap-0.5 rounded-lg border border-subtle bg-surface-2 px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Loader2 size={14} strokeWidth={1.75} aria-hidden className="animate-spin" />
              <span>
                {commandPending === 'compact'
                  ? '正在压缩会话历史…'
                  : `正在执行 /${commandPending}…`}
              </span>
              <span className="text-xs tabular-nums text-tertiary">已进行 {pendingElapsed}s</span>
            </div>
            <div className="text-xs text-tertiary">
              模型正在生成会话摘要，通常需要数秒到几十秒；期间发送已暂停
            </div>
          </div>
        </div>
      )}

      {commandHint && (
        <div className="px-3 py-1 text-xs text-secondary border-t border-subtle">{commandHint}</div>
      )}

      {/* 图片管线内联提示（上限拦截 / 落盘失败，transient 自动消失，spec §11） */}
      {imageHint && (
        <div
          className={`mb-2 px-1 text-xs inline-flex items-center gap-1 ${
            imageHint.kind === 'error' ? 'text-status-error' : 'text-status-warning'
          }`}
        >
          <span>{imageHint.msg}</span>
        </div>
      )}

      {/* 能力提示行（spec §8 场景 1）：有 image pill 且全员无 vision 时提示——
          不阻止发送（历史留缩略图，换模型后近 2 轮可追问） */}
      {hasImagePill && members.length > 0 && members.every((m) => !(m.vision ?? false)) && (
        <div className="mb-2 px-1 text-xs text-secondary inline-flex items-center gap-1">
          <EyeOff size={12} strokeWidth={1.75} aria-hidden className="inline-block align-[-1px]" />
          <span>当前 agent 的模型不支持图片，发送时图片将省略</span>
        </div>
      )}

      {/* F-5：混合团队提示（spec §8 场景 2）——leader 非 vision 且团队存在 vision
          成员时列出可视觉成员名，引导用户 @ 直答或等 leader dispatch 附图 */}
      {hasImagePill && members.some((m) => m.isLeader && !(m.vision ?? false)) &&
        members.some((m) => !m.isLeader && (m.vision ?? false)) && (() => {
          const visionNames = members
            .filter((m) => !m.isLeader && (m.vision ?? false))
            .map((m) => `「${m.agentName}」`)
            .join('、');
          return (
            <div className="mb-2 px-1 text-xs text-secondary inline-flex items-center gap-1">
              <ImageIcon size={12} strokeWidth={1.75} aria-hidden className="inline-block align-[-1px]" />
              <span>团队成员 {visionNames} 可识别图片，@ 直答或让 leader 派发</span>
            </div>
          );
        })()}

      {/* 委派跟踪只读态（T23，预览合同 #18）：输入区整体禁用占位——Lock 14px +
          文案 13px text-disabled，min-height 42px / opacity .5 / 底透明。
          HumanRequestPanel 独立挂载于 composer 上方（T22），不受影响 */}
      {trackingReadOnly ? (
        <div
          data-testid="composer-readonly"
          className="flex min-h-[42px] items-center gap-2 rounded-lg border border-subtle px-3 text-[13px] text-disabled opacity-50"
        >
          <Lock size={14} strokeWidth={1.75} aria-hidden />
          只读跟踪会话 · 操作经请求面板
        </div>
      ) : (
      <div
        className={`relative rounded-lg border bg-surface-2 focus-within:border-focus transition-colors ${
          dragOver ? 'border-dashed border-focus' : 'border-subtle'
        }`}
        onDragEnter={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          dragDepthRef.current += 1;
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragOver(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={endDragVisual}
        onDragEnd={endDragVisual}
      >
        {/* Kimi 式单一容器（v3）：RichComposer 编辑面无边框置顶，pill 内联取代
            chips；框内底行仅剩 📎 左下角；focus 态上移容器边框；拖入文件时
            切换预览 ③ 卡B 悬停态（虚线强调框 + 居中提示，overlay 不挡事件） */}
        {dragOver && (
          <div
            data-testid="drop-hint"
            className="absolute inset-0 z-10 rounded-lg bg-surface-active flex items-center justify-center gap-2 text-sm text-primary pointer-events-none"
          >
            <Upload
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className="text-accent-500 dark:text-accent-300"
            />
            松开鼠标 · 文件将复制到工作空间 imports/
          </div>
        )}
        <RichComposer
          ref={composerRef}
          disabled={!activeSessionId || readOnly}
          placeholder={
            readOnly
              ? '会话只读'
              : activeSessionId
                ? '输入消息，Enter 发送。也可以点上方按钮选择引用'
                : '请先选择房间'
          }
          ariaLabel="消息输入框"
          onInputText={(before) => detectTrigger(before)}
          onNavigate={handleNavigate}
          onPasteImage={(files) => {
            void handlePasteImages(files);
          }}
          onDropFiles={(files) => {
            void importExternalFiles(files);
          }}
          onEnter={() => {
            // 菜单有条目：Enter = 选中高亮项（不发送）；无条目/未开：正常发送。
            // IME/Shift+Enter 守卫在 RichComposer 内
            if (menuOpen) {
              selectActive();
              return;
            }
            void handleSend();
          }}
          onEscape={() => {
            setMenuType(null);
            setScopeQuery('');
            closeMentionScope();
          }}
        />
        <div className="flex items-end gap-2 px-2 pb-2">
          {/* 📎 语义转换（2026-11-05 预览）：引用文件 → 从电脑导入——直接开系统
              文件选择器（不再打开 @ 菜单）；图标保持 Paperclip 附件心智 */}
          <IconButton
            aria-label="从电脑导入"
            title="从电脑导入"
            disabled={!activeSessionId || readOnly}
            onClick={openImportPicker}
          >
            <Paperclip size={16} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            data-testid="import-file-input"
            onChange={handleImportChange}
          />
        </div>
      </div>
      )}
    </div>
  );
}
