// renderer/src/stores/hub-view.store.ts
//
// 远程查看面板数据源（momo-hub M2e T14 leader 侧，spec §5.4 四视图 + MC3）：
// - 打开面板 = view.workspace + view.sessions + view.tasks 三发（页签切换不重复拉
//   概览数据——缓存；刷新 iconbtn 手动重拉当前页签）
// - 回放视图：进入 = view.messages（含头尾部一页 fromSeq=max(1,lastSeq-limit+1)）+
//   view.subscribe（恰好一次）；「加载更早」= fromSeq 递减再拉一页（锚顶语义）；
//   回放态「刷新」= refreshReplay（退订→重订锚点重置→已知尾后补拉，间隙自愈）
// - 实时增量只经 hub:viewAppended 事件驱动（MC3 无轮询）——按 seq 去重淡入追加
// - 订阅生命周期：离开回放（返回/切页签/关面板/断开按钮）四路径都恰好一次
//   view.unsubscribe（组件卸载语义，不留悬挂订阅）
// - 错误路径人话化：forbidden（对方关闭查看）/ node_offline / not_found
// - M3.2（协议 1.4.0）：openRemotePick 远端空间清单选择前置步（viewWorkspaces，
//   hub ≥1.4 门控在 WorkgroupView；旧 hub 回落本机清单 openPanel 旧路径）+ files
//   子域（目录懒加载树 + 文件 base64 解码预览 + 500/256KB truncated 标记；无订阅
//   ——teardown 不需 unsubscribe）；view.* 调用一律携带发起时选中组 groupId
//   （boundary 铁律 5：路由目标用当前上下文，消 commonGroupId 多组任意取旧歧义）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  HubViewFileEntry, HubViewLocalTask, HubViewMessage, HubViewOverview, HubViewSessionSummary,
} from '../ipc/types';

export type ViewTab = 'overview' | 'sessions' | 'tasks' | 'files' | 'config';

/** 回放页尺寸（与目标端 MESSAGES_LIMIT_MAX 对齐） */
export const VIEW_PAGE_SIZE = 50;

export interface ViewReplayState {
  sessionId: string;
  title: string;
  messages: HubViewMessage[];
  /** 顶部「加载更早」是否还有更早事件（false → 已到最早） */
  hasMore: boolean;
  loadingEarlier: boolean;
  /** 尾部订阅在线（view.subscribe 成功后 true；断开/离线降级 false） */
  live: boolean;
  /** 订阅中断人话（节点离线 / forbidden）——null=正常 */
  liveError: string | null;
  /** view.appended 批次分隔标记（seq = 批末事件 seq；渲染淡入分隔条） */
  batches: Record<number, true>;
}

/** 文件预览态（view.files read 产物；binary=true 时 content 为空——文本预览不可用） */
export interface ViewFilePreview {
  /** 工作空间内相对路径（'/' 分隔，根相对） */
  path: string;
  content: string;
  /** 原始字节数（截断前——与 truncated 配合可算被截掉量） */
  size: number;
  truncated: boolean;
  binary: boolean;
}

/** files 子域状态（M3.2）：目录栈 + 内容缓存 + truncated 标记 */
export interface ViewFilesState {
  /** 已加载目录（'.' = 根）：relPath → 条目页 */
  dirs: Record<string, { entries: HubViewFileEntry[]; truncated: boolean }>;
  preview: ViewFilePreview | null;
  /** 在途目录列举（relPath；非 null 时拒绝并发列举） */
  loadingDir: string | null;
  /** 在途文件读取（relPath） */
  loadingFile: string | null;
  /** files 子域局部错误（humanize 链；面板级 error 不混用） */
  error: string | null;
}

function emptyFiles(): ViewFilesState {
  return { dirs: {}, preview: null, loadingDir: null, loadingFile: null, error: null };
}

/** base64 → 字节（view.files read 内容解码；renderer 无 Buffer，用 atob） */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface HubViewState {
  open: boolean;
  /** 空间选择前置步（本机多工作空间时先选再看） */
  picking: boolean;
  /** M3.2：选择器数据源为远端清单（openRemotePick 置位；本机回落路径恒 false） */
  pickerRemote: boolean;
  /** M3.2：远端清单行（viewWorkspaces 产物；本机模式 null——dialog 走 workspaceStore） */
  pickerWorkspaces: Array<{ id: string; name: string }> | null;
  /** M3.2：远端清单拉取在途（dialog spinner 位） */
  remoteLoading: boolean;
  targetNodeId: string | null;
  targetName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  /** 发起查看时的选中组（view.* 载荷 groupId；null = 不携带走 hub 旧路径） */
  groupId: string | null;
  tab: ViewTab;
  overview: HubViewOverview | null;
  sessions: HubViewSessionSummary[];
  tasks: HubViewLocalTask[];
  files: ViewFilesState;
  loading: boolean;
  /** 面板级错误（forbidden / node_offline / not_found 人话） */
  error: string | null;
  replay: ViewReplayState | null;

  /** 面板挂载时调用：订阅 view.appended；返回解订阅函数 */
  init(): () => void;
  openPanel(input: {
    targetNodeId: string;
    targetName: string;
    workspaces: Array<{ id: string; name: string }>;
    /** 发起查看时的选中组 id（缺省不携带） */
    groupId?: string | null;
  }): void;
  /**
   * M3.2 远端清单前置步：进 picking 态即拉 viewWorkspaces（带 groupId），单空间
   * 自动直达（与 openPanel 同语义）；失败人话落 error、清单空落 pickerWorkspaces=[]
   * （dialog 呈「目标节点暂无工作空间」）。
   */
  openRemotePick(input: { targetNodeId: string; targetName: string; groupId: string | null }): void;
  close(): void;
  pickWorkspace(workspaceId: string, workspaceName: string): void;
  switchTab(tab: ViewTab): void;
  refresh(): Promise<void>;
  enterReplay(session: HubViewSessionSummary): Promise<void>;
  loadEarlier(): Promise<void>;
  /**
   * 回放态「刷新」自愈路径（fix round 1）：重订语义 = 先退订清 watcher、再重订
   * （subscribe 对已存在 watcher 幂等不重锚，必须先 unsubscribe 锚点才重置到当前
   * 尾），随后从已知最后一条之后补拉一页——覆盖「messages 应答与订阅锚定间」
   * 到达的间隙事件（低于锚点永不经 tail，两不沾），与并发 tail 扇出按 seq 去重。
   */
  refreshReplay(): Promise<void>;
  leaveReplay(): void;
  /** 回放视图头「断开订阅」：显式 unsubscribe，按钮转 disabled */
  disconnectLive(): Promise<void>;
  /** files 子域：懒加载目录（已加载/在途则幂等跳过；'.' = 根） */
  loadFilesDir(relPath: string): Promise<void>;
  /** files 子域：读取文件并解码预览（在途则跳过） */
  openFilePreview(relPath: string): Promise<void>;
  closeFilePreview(): void;
}

/** forbidden 等 hub 错误码 → 面板人话 */
export function humanizeViewError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('已关闭本组查看')) return '对方节点关闭了本组查看——可在其「设置 → 节点互联」重新开启';
  if (msg.includes('不在线') || msg.includes('离线')) return '目标节点不在线——连接恢复后可重试';
  return msg;
}

export const useHubViewStore = create<HubViewState>((set, get) => {
  let disposeAppended: (() => void) | null = null;

  /** view.* 载荷组上下文段（铁律 5）：groupId 在场则携带（协议可选段），缺省空段保持旧形状 */
  const groupSeg = (): { groupId?: string } => {
    const { groupId } = get();
    return groupId !== null ? { groupId } : {};
  };

  const teardownReplay = (): void => {
    const st = get();
    if (!st.replay || !st.targetNodeId) {
      set({ replay: null });
      return;
    }
    const { targetNodeId } = st;
    set({ replay: null });
    void ipc.hub
      .viewUnsubscribe({ targetNodeId, sessionId: st.replay.sessionId, ...groupSeg() })
      .then(
        () => undefined,
        () => undefined, // 幂等清理：hub/目标侧豁免路径，本地静默即可
      );
  };

  const loadAll = async (): Promise<void> => {
    const st = get();
    if (!st.targetNodeId || !st.workspaceName) return;
    set({ loading: true });
    try {
      const [overview, sessions, tasks] = await Promise.all([
        ipc.hub.viewWorkspace({ targetNodeId: st.targetNodeId, workspaceName: st.workspaceName, ...groupSeg() }),
        ipc.hub.viewSessions({ targetNodeId: st.targetNodeId, workspaceName: st.workspaceName, limit: 50, ...groupSeg() }),
        ipc.hub.viewTasks({ targetNodeId: st.targetNodeId, workspaceName: st.workspaceName, ...groupSeg() }),
      ]);
      set({ overview, sessions: sessions.sessions, tasks: tasks.tasks, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: humanizeViewError(err) });
    }
  };

  return {
    open: false,
    picking: false,
    pickerRemote: false,
    pickerWorkspaces: null,
    remoteLoading: false,
    targetNodeId: null,
    targetName: null,
    workspaceId: null,
    workspaceName: null,
    groupId: null,
    tab: 'overview',
    overview: null,
    sessions: [],
    tasks: [],
    files: emptyFiles(),
    loading: false,
    error: null,
    replay: null,

    init() {
      if (disposeAppended) return () => undefined;
      disposeAppended = ipc.hub.onViewAppended((evt) => {
        const st = get();
        if (!st.replay || st.replay.sessionId !== evt.sessionId) return;
        const known = new Set(st.replay.messages.map((m) => m.seq));
        const fresh = evt.events.filter((e) => !known.has(e.seq));
        if (fresh.length === 0) return;
        const lastSeq = fresh[fresh.length - 1]!.seq;
        const batches = { ...st.replay.batches, [lastSeq]: true as const };
        set({
          replay: {
            ...st.replay,
            messages: [...st.replay.messages, ...fresh],
            batches,
            live: true,
            liveError: null,
          },
        });
      });
      const dispose = (): void => {
        disposeAppended?.();
        disposeAppended = null;
      };
      return dispose;
    },

    openPanel({ targetNodeId, targetName, workspaces, groupId = null }) {
      teardownReplay();
      if (workspaces.length <= 1) {
        const only = workspaces[0];
        if (!only) {
          set({
            open: true, picking: false, pickerRemote: false, pickerWorkspaces: null, remoteLoading: false,
            targetNodeId, targetName, groupId,
            workspaceId: null, workspaceName: null, tab: 'overview',
            overview: null, sessions: [], tasks: [], files: emptyFiles(), loading: false,
            error: '本机尚无工作空间——先在工作空间页创建或镜像后查看', replay: null,
          });
          return;
        }
        set({
          open: true, picking: false, pickerRemote: false, pickerWorkspaces: null, remoteLoading: false,
          targetNodeId, targetName, groupId,
          workspaceId: only.id, workspaceName: only.name, tab: 'overview',
          overview: null, sessions: [], tasks: [], files: emptyFiles(), loading: false, error: null, replay: null,
        });
        void loadAll();
        return;
      }
      set({
        open: true, picking: true, pickerRemote: false, pickerWorkspaces: null, remoteLoading: false,
        targetNodeId, targetName, groupId,
        workspaceId: null, workspaceName: null, tab: 'overview',
        overview: null, sessions: [], tasks: [], files: emptyFiles(), loading: false, error: null, replay: null,
      });
    },

    openRemotePick({ targetNodeId, targetName, groupId }) {
      teardownReplay();
      set({
        open: true, picking: true, pickerRemote: true, pickerWorkspaces: null, remoteLoading: true,
        targetNodeId, targetName, groupId,
        workspaceId: null, workspaceName: null, tab: 'overview',
        overview: null, sessions: [], tasks: [], files: emptyFiles(), loading: false, error: null, replay: null,
      });
      void ipc.hub
        .viewWorkspaces({ targetNodeId, ...(groupId !== null ? { groupId } : {}) })
        .then((res) => {
          // 拉取在途期间面板可能被关闭/换目标——closed 后不落状态
          const cur = get();
          if (!cur.open || !cur.picking || cur.targetNodeId !== targetNodeId) return;
          const workspaces = res.workspaces.map((w) => ({ id: w.id, name: w.name }));
          if (workspaces.length <= 1) {
            const only = workspaces[0];
            if (!only) {
              set({ remoteLoading: false, pickerWorkspaces: [] });
              return;
            }
            set({
              remoteLoading: false, picking: false, pickerWorkspaces: null,
              workspaceId: only.id, workspaceName: only.name,
            });
            void loadAll();
            return;
          }
          set({ remoteLoading: false, pickerWorkspaces: workspaces });
        })
        .catch((err: unknown) => {
          const cur = get();
          if (!cur.open || !cur.picking) return;
          set({ remoteLoading: false, pickerWorkspaces: [], error: humanizeViewError(err) });
        });
    },

    close() {
      teardownReplay();
      set({
        open: false, picking: false, pickerRemote: false, pickerWorkspaces: null, remoteLoading: false,
        groupId: null, files: emptyFiles(), replay: null,
      });
    },

    pickWorkspace(workspaceId, workspaceName) {
      if (!get().picking) return;
      set({ picking: false, pickerRemote: false, pickerWorkspaces: null, remoteLoading: false, workspaceId, workspaceName });
      void loadAll();
    },

    switchTab(tab) {
      if (get().replay) teardownReplay(); // 切页签 = 离开回放（unsubscribe）
      set({ tab });
    },

    async refresh() {
      if (get().replay) {
        await get().refreshReplay(); // 回放态刷新 = 重订 + 尾后补拉（不自愈路径外的概览面）
        return;
      }
      // 文件页刷新 = 目录树整域重载（根起逐层重展开；预览一并失效）
      if (get().tab === 'files') {
        set({ files: emptyFiles() });
        await get().loadFilesDir('.');
        return;
      }
      await loadAll();
    },

    async enterReplay(session) {
      const st = get();
      if (!st.targetNodeId || !st.workspaceName || st.replay) return;
      // 含头窗口：恰 50 条含头含尾（服务端 rowid>=fromSeq ASC LIMIT 50 保留最低
      // 50 条——旧式 lastSeq-50 开窗含 51 值会在稠密 rowid 下丢 seq=lastSeq 尾事件，
      // 且该事件低于订阅锚点永不经 tail 到达；下限 1 防负越界到全量页）
      const fromSeq = Math.max(1, session.lastSeq - VIEW_PAGE_SIZE + 1);
      set({ loading: true });
      try {
        const page = await ipc.hub.viewMessages({
          targetNodeId: st.targetNodeId,
          sessionId: session.sessionId,
          workspaceName: st.workspaceName,
          fromSeq,
          limit: VIEW_PAGE_SIZE,
          ...groupSeg(),
        });
        set({
          loading: false,
          replay: {
            sessionId: session.sessionId,
            title: session.title,
            messages: page.messages,
            hasMore: page.hasMore,
            loadingEarlier: false,
            live: false,
            liveError: null,
            batches: {},
          },
        });
      } catch (err) {
        set({ loading: false, error: humanizeViewError(err) });
        return;
      }
      // 进入回放恰好一次 subscribe（失败降级「已断开」可手动重订）
      try {
        await ipc.hub.viewSubscribe({ targetNodeId: st.targetNodeId, sessionId: session.sessionId, ...groupSeg() });
        const cur = get().replay;
        if (cur && cur.sessionId === session.sessionId) set({ replay: { ...cur, live: true } });
      } catch (err) {
        const cur = get().replay;
        if (cur && cur.sessionId === session.sessionId) {
          set({ replay: { ...cur, live: false, liveError: humanizeViewError(err) } });
        }
      }
    },

    async loadEarlier() {
      const st = get();
      if (!st.replay || !st.targetNodeId || !st.workspaceName) return;
      if (st.replay.loadingEarlier || !st.replay.hasMore) return;
      const firstSeq = st.replay.messages.length > 0 ? st.replay.messages[0]!.seq : 0;
      const fromSeq = Math.max(0, firstSeq - VIEW_PAGE_SIZE);
      set({ replay: { ...st.replay, loadingEarlier: true } });
      try {
        const page = await ipc.hub.viewMessages({
          targetNodeId: st.targetNodeId,
          sessionId: st.replay.sessionId,
          workspaceName: st.workspaceName,
          fromSeq,
          limit: VIEW_PAGE_SIZE,
          ...groupSeg(),
        });
        const known = new Set(st.replay.messages.map((m) => m.seq));
        const fresh = page.messages.filter((m) => !known.has(m.seq));
        set({
          replay: {
            ...get().replay!,
            messages: [...fresh, ...get().replay!.messages],
            hasMore: page.hasMore,
            loadingEarlier: false,
          },
        });
      } catch (err) {
        set({ replay: { ...get().replay!, loadingEarlier: false }, error: humanizeViewError(err) });
      }
    },

    leaveReplay() {
      teardownReplay();
    },

    async refreshReplay() {
      const st = get();
      if (!st.replay || !st.targetNodeId || !st.workspaceName) return;
      if (st.loading) return;
      const { targetNodeId, workspaceName } = st;
      const sessionId = st.replay.sessionId;
      const knownLast = st.replay.messages.length > 0
        ? st.replay.messages[st.replay.messages.length - 1]!.seq
        : 0;
      set({ loading: true });
      // 重订：先退订（幂等豁免路径静默）——旧 watcher 不清则重订不重锚
      await ipc.hub
        .viewUnsubscribe({ targetNodeId, sessionId, ...groupSeg() })
        .then(() => undefined, () => undefined);
      try {
        await ipc.hub.viewSubscribe({ targetNodeId, sessionId, ...groupSeg() });
      } catch (err) {
        // 旧订阅已随退订移除：降级「已断开」人话（可再刷新/重进重试）
        const cur = get().replay;
        set(
          cur && cur.sessionId === sessionId
            ? { loading: false, replay: { ...cur, live: false, liveError: humanizeViewError(err) } }
            : { loading: false },
        );
        return;
      }
      try {
        const page = await ipc.hub.viewMessages({
          targetNodeId,
          sessionId,
          workspaceName,
          fromSeq: knownLast + 1,
          limit: VIEW_PAGE_SIZE,
          ...groupSeg(),
        });
        const cur = get().replay;
        if (!cur || cur.sessionId !== sessionId) {
          set({ loading: false });
          return;
        }
        // 已知集取补拉应答后的现值：await 期间 view.appended 并发追加了同 seq
        // 事件也在此去重（hasMore 属顶侧分页状态，尾部追加不动它）
        const known = new Set(cur.messages.map((m) => m.seq));
        const fresh = page.messages.filter((m) => !known.has(m.seq));
        set({
          loading: false,
          replay: { ...cur, messages: [...cur.messages, ...fresh], live: true, liveError: null },
        });
      } catch (err) {
        const cur = get().replay;
        set(
          cur && cur.sessionId === sessionId
            ? { loading: false, error: humanizeViewError(err), replay: { ...cur, live: true, liveError: null } }
            : { loading: false, error: humanizeViewError(err) },
        );
      }
    },

    async disconnectLive() {
      const st = get();
      if (!st.replay || !st.targetNodeId || !st.replay.live) return;
      const { targetNodeId } = st;
      const sessionId = st.replay.sessionId;
      set({ replay: { ...st.replay, live: false } });
      try {
        await ipc.hub.viewUnsubscribe({ targetNodeId, sessionId, ...groupSeg() });
      } catch {
        // 幂等清理路径——hub 侧豁免，静默即可
      }
    },

    async loadFilesDir(relPath) {
      const st = get();
      if (!st.targetNodeId || !st.workspaceName) return;
      if (st.files.dirs[relPath] !== undefined || st.files.loadingDir !== null) return;
      set({ files: { ...st.files, loadingDir: relPath, error: null } });
      try {
        const res = await ipc.hub.viewFiles({
          targetNodeId: st.targetNodeId,
          workspaceName: st.workspaceName,
          op: 'list',
          ...(relPath !== '.' ? { path: relPath } : {}),
          ...groupSeg(),
        });
        const cur = get();
        if (!cur.open || cur.files.loadingDir !== relPath) return; // 面板已关或目标目录已切换
        if (!('entries' in res)) {
          set({ files: { ...cur.files, loadingDir: null, error: 'view.files 应答形状异常（期望 entries）' } });
          return;
        }
        set({
          files: {
            ...cur.files,
            dirs: { ...cur.files.dirs, [relPath]: { entries: res.entries, truncated: res.truncated } },
            loadingDir: null,
          },
        });
      } catch (err) {
        const cur = get();
        if (!cur.open || cur.files.loadingDir !== relPath) return;
        set({ files: { ...cur.files, loadingDir: null, error: humanizeViewError(err) } });
      }
    },

    async openFilePreview(relPath) {
      const st = get();
      if (!st.targetNodeId || !st.workspaceName) return;
      if (st.files.loadingFile !== null) return;
      set({ files: { ...st.files, loadingFile: relPath, error: null } });
      try {
        const res = await ipc.hub.viewFiles({
          targetNodeId: st.targetNodeId,
          workspaceName: st.workspaceName,
          op: 'read',
          path: relPath,
          ...groupSeg(),
        });
        const cur = get();
        if (!cur.open || cur.files.loadingFile !== relPath) return;
        if (!('content' in res)) {
          set({ files: { ...cur.files, loadingFile: null, error: 'view.files 应答形状异常（期望 content）' } });
          return;
        }
        const bytes = base64ToBytes(res.content);
        const text = new TextDecoder('utf-8').decode(bytes);
        // 二进制检测与 file:readForEditor 同法：utf-8 解码再编码与原字节不一致即二进制
        const reEncoded = new TextEncoder().encode(text);
        const binary = reEncoded.length !== bytes.length || reEncoded.some((b, i) => b !== bytes[i]);
        set({
          files: {
            ...cur.files,
            loadingFile: null,
            preview: { path: relPath, content: binary ? '' : text, size: res.size, truncated: res.truncated, binary },
          },
        });
      } catch (err) {
        const cur = get();
        if (!cur.open || cur.files.loadingFile !== relPath) return;
        set({ files: { ...cur.files, loadingFile: null, error: humanizeViewError(err) } });
      }
    },

    closeFilePreview() {
      set((s) => ({ files: { ...s.files, preview: null } }));
    },
  };
});
