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
import { Fragment, useEffect, useRef, useState } from 'react';
import { Bot, EyeOff, FileText, Image as ImageIcon, Lock, Paperclip, Pin, Terminal, Zap } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
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
import type { SearchHit, SessionMemberInfo, TaskRow, TaskStatus } from '../../ipc/types';

type MenuKind = 'agent' | 'task' | 'command';

/** 菜单条目分组（@ 菜单 agent+file 双组、/ 菜单 command+skill 双组、# 单组） */
type MenuGroup = 'agent' | 'file' | 'task' | 'command' | 'skill';

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
  select: () => void;
}

const GROUP_LABEL: Record<MenuGroup, string> = {
  agent: '选择要 @ 的 agent',
  file: '引用文件',
  task: '选择要引用的任务',
  command: '命令',
  skill: '技能',
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
  }
}

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
/**
 * @ 菜单图片分流判定（spec §5）：命中扩展名的文件条目走 image 通道
 * （lucide-image 图标 + 选中插 image pill），其余照旧 file 通道。
 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** 内联图片提示自动消失间隔（毫秒） */
const IMAGE_HINT_TIMEOUT_MS = 4000;

export function MentionInput() {
  const [menuType, setMenuType] = useState<MenuKind | null>(null);
  const [query, setQuery] = useState('');
  // 菜单键盘导航高亮索引（跨组扁平序列；query/菜单类型变化回顶，条目缩水渲染期 clamp）
  const [activeIndex, setActiveIndex] = useState(0);
  const menuListRef = useRef<HTMLDivElement>(null);
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
  // 图片管线内联提示（上限拦截 / downscale·saveImage 失败）与能力提示行的
  // pill 存在标记（spec §8 场景 1）。imageHint 定时自动消失（transient）
  const [imageHint, setImageHint] = useState<{ kind: 'warn' | 'error'; msg: string } | null>(null);
  const imageHintTimerRef = useRef<number | null>(null);
  const [hasImagePill, setHasImagePill] = useState(false);

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
    syncImageHint();
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
   * onInputText）——必须显式关菜单清 query，并同步能力提示行。
   */
  const selectWithPill = (pill: Omit<PillSeg, 'type'>): void => {
    const replaceLen = 1 + query.length;
    composerRef.current?.insertPill({ type: 'pill', ...pill }, replaceLen);
    // 菜单 button 的 mousedown 偷走焦点（v2.11.1 insertMention 同款问题）——
    // 选择后显式恢复，否则键盘输入落空。insertPill 已设好 selection，focus
    // 保留元素内既有选区；勿用 moveCaretToEnd——中段插入场景会错误跳末尾
    composerRef.current?.focus();
    setMenuType(null);
    setQuery('');
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

  /** 当前菜单的跨组扁平条目（渲染与键盘导航共用同一序列） */
  const menuEntries: MenuEntry[] = [];
  if (menuType === 'agent') {
    for (const m of filteredMembers) {
      menuEntries.push({
        key: `agent:${m.instanceId}`,
        group: 'agent',
        primary: m.agentName,
        iconEmoji: m.iconEmoji ?? undefined,
        select: () => selectMember(m),
      });
    }
    for (const f of fileHits) {
      menuEntries.push({
        key: `file:${f.path}`,
        group: 'file',
        primary: f.path,
        image: IMAGE_EXT_RE.test(f.path),
        select: () => selectFile(f),
      });
    }
  } else if (menuType === 'task') {
    for (const t of filteredTasks) {
      menuEntries.push({
        key: `task:${t.id}`,
        group: 'task',
        primary: `#${t.id} · ${t.title}`,
        select: () => selectTask(t),
      });
    }
  } else if (menuType === 'command') {
    for (const c of filteredCommands) {
      menuEntries.push({
        key: `command:${c.name}`,
        group: 'command',
        primary: `/${c.name}`,
        secondary: c.description,
        select: () => selectCommand(c.name),
      });
    }
    for (const s of filteredSkills) {
      menuEntries.push({ key: `skill:${s.slug}`, group: 'skill', primary: s.name, select: () => selectSkill(s) });
    }
  }
  const menuOpen = menuEntries.length > 0;
  // 文件命中异步到达会缩列表：clamp 防越界（高亮粘到末条）
  const activeIdx = menuEntries.length === 0 ? 0 : Math.min(activeIndex, menuEntries.length - 1);

  // 过滤词/菜单类型变化 → 高亮回顶（新序列语义上已是另一份列表）
  useEffect(() => {
    setActiveIndex(0);
  }, [menuType, query]);

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
    syncImageHint();
    setMenuType(null);
    setQuery('');
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
                  {entry.image ? (
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
          onNavigate={handleNavigate}
          onPasteImage={(files) => {
            void handlePasteImages(files);
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
