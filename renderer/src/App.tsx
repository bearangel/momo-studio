// renderer/src/App.tsx
//
// v2.0 P1 Task 11：无登录概念——启动分支由 workspace 判定（SQLite 是唯一状态源）。
//   - 已有 workspace → 直接进入 MainShell
//
// M2.1 D1（2026-10-26 真机验收）：0 工作空间不再是整壳替换态——统一渲染
// MainShell（TitleBar + 活动栏 + 主区），主区由 MiddlePanel 的 !workspace
// 分支承载「创建或选择工作空间」引导（含内嵌创建表单）。工作组是节点级能力
// （UC8：新设备零前置接入），活动栏必须在 0-ws 状态即可达；首启创建表单
// 原语义随主区引导保留（表单本体见 MiddlePanel）。
//
// P5 Task 2：升级首启提示——bootstrapped 后 invoke getUpgradeNotice，
// 有标记 → 在 MainShell 同屏渲染 UpgradeNotice（D1 后 0-ws 也走 MainShell
// 分支，升级标记不再被空态吞掉——2.0 升级用户删光空间也能看到导出位置）。
import { useEffect, useState, useCallback } from 'react';
import { useWorkspaceStore, subscribeWorkspaceListChanged } from './stores/workspace.store';
import { useEditorStore } from './stores/editor.store';
import { subscribeSessionChannels, useSessionStore } from './stores/session.store';
import { useWriteGrantStore } from './stores/write-grant.store';
import { MainShell } from './routes/MainShell';
import { OnboardingWizard } from './routes/OnboardingWizard';
import { TitleBar } from './components/layout/TitleBar';
import { ClosedWorkspacesPanel } from './components/layout/WorkspaceTabs';
import { UpgradeNotice } from './components/upgrade/UpgradeNotice';
import { SandboxNotice } from './components/settings/SandboxNotice';
import { ResumeNotice } from './components/task/ResumeNotice';
import { BrowserTrustNotice } from './components/workspace/BrowserTrustNotice';
import { BrowserWaitReleasePrompt } from './components/workspace/BrowserWaitReleasePrompt';
import { CenterPromptLayer } from './components/notices/CenterPromptLayer';
import { BrowserCloseConfirmCard } from './components/notices/BrowserCloseConfirmCard';
import { NoticeStack } from './components/notices/NoticeStack';
import { ipc } from './ipc/client';

export function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const closedIds = useWorkspaceStore((s) => s.closedIds);
  const load = useWorkspaceStore((s) => s.load);
  // 首次列表返回前不渲染首启对话框，避免加载期间闪现（store 初始态 workspaces=[]）
  const [bootstrapped, setBootstrapped] = useState(false);
  // P5 Task 2：v1.x → 2.0 旧库升级标记（导出目录）；null = 无标记
  const [upgradeExportDir, setUpgradeExportDir] = useState<string | null>(null);
  // 新装引导（spec 2026-10-10 §3.1）：pending → 向导；completed/skipped → 原空态。
  // 拉取失败按 pending（引导是容错增强，不阻塞启动）；obCheck 在向导收尾后自增重拉
  // ——跳过路径 workspaces 仍为空，须靠 status=skipped 防向导重现。
  const [, setObStatus] = useState<'pending' | 'completed' | 'skipped'>('pending');
  const [obCheck, setObCheck] = useState(0);
  // C1 闩锁（终审）：向导一经挂载，进行期 store.create 使 workspaces 变非空也
  // 不得卸载——判定收敛为 wizardOpen 单点，仅在本 effect（boot / 收尾重拉）与
  // onWizardFinished 里翻转；向导中途任何 store 更新都碰不到它
  const [wizardOpen, setWizardOpen] = useState(false);

  // 全局会话通道订阅（session:message + session:message_event_batch；
  // Task 12 起全部发送方统一走 session:* 通道，无桥接）。
  // subscribeSessionChannels 内部同时喂 session.store 和 stream.store——同一份 batch
  // 既累积到 session.store.eventsByMessage（重启还原用），又聚合到
  // stream.store.streams（UI 实时渲染用）。
  // 放在 App 顶层保证整个生命周期只订阅一次，避免视图切换重复注册。
  useEffect(() => subscribeSessionChannels(), []);

  // 主进程侧工作空间变更（M2.1 D3：镜像应用落地）→ 重拉列表——renderer 无感知
  // 的落库路径经推送对账（冷启动链：0-ws 态收到镜像即翻转入主壳）
  useEffect(() => subscribeWorkspaceListChanged(), []);

  // 通用写拦截信号（spec 2026-10-03 §5.3）：主进程检测命中即推，直弹授权卡
  //（取代旧的批次子串扫描链——见 write-grant.store）
  useEffect(
    () =>
      ipc.sandbox.onWriteBlocked((e) =>
        useWriteGrantStore.getState().receiveWriteBlocked(e),
      ),
    [],
  );

  // 活跃会话上报（归属制 spec §5.4）：main 的自动展开判定（expandHint 只对活跃
  // 会话生效）输入；null = 非会话视图（安全缺省）。含启动后首次。
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  useEffect(() => {
    void ipc.browser.setActiveSession(activeSessionId).catch(() => {
      // 早期 boot 未挂载时静默——下一个 session 切换自会重报
    });
  }, [activeSessionId]);

  useEffect(() => {
    void load().finally(() => setBootstrapped(true));
  }, [load]);

  // 编辑器分片绑定（工作空间隔离）：activeWorkspaceId 变化即切换 editor.store
  // 当前分片。放 App 顶层保证在任何 openFile（文件树点击/消息 chip）前完成绑定
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  useEffect(() => {
    useEditorStore.getState().setWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId]);

  // 新装引导：bootstrapped 后（及向导每次收尾后）拉取一次性状态；失败静默按 pending。
  // wizardOpen 只在此处置 true（boot 时 pending 且无 ws）或置 false（收尾重拉见终态）
  useEffect(() => {
    if (!bootstrapped) return;
    void ipc.onboarding
      .getStatus()
      .then((r) => {
        setObStatus(r.status);
        setWizardOpen(r.status === 'pending' && useWorkspaceStore.getState().workspaces.length === 0);
      })
      .catch(() => {
        setObStatus('pending');
        setWizardOpen(useWorkspaceStore.getState().workspaces.length === 0);
      });
  }, [bootstrapped, obCheck]);

  // 向导收尾（完成或跳过）：乐观收闩 + 重拉 status + workspaces——完成→ws 非空；
  // 跳过→status=skipped 落回 0-ws 主壳（主区创建引导表单）
  const onWizardFinished = useCallback(() => {
    setWizardOpen(false);
    setObCheck((n) => n + 1);
    void load();
  }, [load]);

  // P5 Task 2：bootstrapped 后一次性拉取升级标记——新装用户无标记，
  // 旧库用户则有 exportDir。MainShell 同屏渲染 UpgradeNotice 告知导出位置。
  // 「知道了」→ 调 IPC 清标记（一次性），本地 state 也清。
  useEffect(() => {
    if (!bootstrapped) return;
    void ipc.system
      .getUpgradeNotice()
      .then((n) => {
        if (n) setUpgradeExportDir(n.exportDir);
      })
      .catch(() => {
        // 拉取失败不阻塞启动——首启提示是体验性增强，不是关键路径
      });
  }, [bootstrapped]);

  const dismissUpgrade = useCallback(() => {
    setUpgradeExportDir(null);
    void ipc.system.dismissUpgradeNotice();
  }, []);

  if (!bootstrapped) return null;

  // 向导闩锁优先于 workspaces 判空（C1：进行期 ws 创建不得卸载向导）
  if (wizardOpen) {
    return <OnboardingWizard onFinished={onWizardFinished} />;
  }

  // D6（关标签 ≠ 删除）：workspaces 非空但可见标签全部关闭 → 重开面板
  //（TitleBar 下方占满内容区；判定只看可见标签）。重开 / 新建后自动回到
  // MainShell。0-ws 不入此分支（every 对空数组恒 true——D1 后 0-ws 走
  // MainShell 主壳，不渲染重开面板）。
  if (workspaces.length > 0 && workspaces.every((ws) => closedIds.includes(ws.id))) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
        <TitleBar />
        <ClosedWorkspacesPanel />
      </div>
    );
  }

  return (
    <>
      <MainShell />
      {/* Tier B 告知堆叠（安全区右下）：三自管卡 + 死信 toast（NoticeStack 内部订阅）。
          三卡显隐语义不变：Sandbox / Resume 组件内部自管（不满足条件返回 null）；
          Upgrade 沿用 upgradeExportDir 条件渲染（P5 Task 2） */}
      <NoticeStack>
        <SandboxNotice />
        <ResumeNotice />
        {upgradeExportDir && (
          <UpgradeNotice exportDir={upgradeExportDir} onDismiss={dismissUpgrade} />
        )}
      </NoticeStack>
      {/* 提示分级（spec 2026-09-15）：Tier A 阻断确认居中层（信任/释放/关闭确认自管显隐） */}
      <CenterPromptLayer>
        <BrowserTrustNotice />
        <BrowserWaitReleasePrompt />
        <BrowserCloseConfirmCard />
      </CenterPromptLayer>
    </>
  );
}
