// renderer/src/App.tsx
//
// v2.0 P1 Task 11：无登录概念——启动分支由 workspace 判定（SQLite 是唯一状态源）。
//   - 已有 workspace → 直接进入 MainShell
//   - 无 workspace → 首启空态：TitleBar + 内嵌 CreateWorkspaceDialog
//     （P2 Task 3 空态也包 TitleBar——frameless 下保留拖拽/关闭；tabs 只剩 ＋，
//     正好引导创建第一个 workspace）
//
// P5 Task 2：升级首启提示——bootstrapped 后 invoke getUpgradeNotice，
// 有标记 → 在 MainShell 同屏渲染 UpgradeNotice；首启空态分支不受影响
// （新装用户无标记；仅 MainShell 分支承载升级提示）。
import { useEffect, useState, useCallback } from 'react';
import { useWorkspaceStore } from './stores/workspace.store';
import { subscribeSessionChannels, useSessionStore } from './stores/session.store';
import { useWriteGrantStore } from './stores/write-grant.store';
import { CreateWorkspaceDialog } from './components/workspace/CreateWorkspaceDialog';
import { MainShell } from './routes/MainShell';
import { OnboardingWizard } from './routes/OnboardingWizard';
import { TitleBar } from './components/layout/TitleBar';
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
  const load = useWorkspaceStore((s) => s.load);
  // 首次列表返回前不渲染首启对话框，避免加载期间闪现（store 初始态 workspaces=[]）
  const [bootstrapped, setBootstrapped] = useState(false);
  // P5 Task 2：v1.x → 2.0 旧库升级标记（导出目录）；null = 无标记
  const [upgradeExportDir, setUpgradeExportDir] = useState<string | null>(null);
  // 新装引导（spec 2026-10-10 §3.1）：pending → 向导；completed/skipped → 原空态。
  // 拉取失败按 pending（引导是容错增强，不阻塞启动）；obCheck 在向导收尾后自增重拉
  // ——跳过路径 workspaces 仍为空，须靠 status=skipped 防向导重现。
  const [obStatus, setObStatus] = useState<'pending' | 'completed' | 'skipped'>('pending');
  const [obCheck, setObCheck] = useState(0);

  // 全局会话通道订阅（session:message + session:message_event_batch；
  // Task 12 起全部发送方统一走 session:* 通道，无桥接）。
  // subscribeSessionChannels 内部同时喂 session.store 和 stream.store——同一份 batch
  // 既累积到 session.store.eventsByMessage（重启还原用），又聚合到
  // stream.store.streams（UI 实时渲染用）。
  // 放在 App 顶层保证整个生命周期只订阅一次，避免视图切换重复注册。
  useEffect(() => subscribeSessionChannels(), []);

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

  // 新装引导：bootstrapped 后（及向导每次收尾后）拉取一次性状态；失败静默按 pending
  useEffect(() => {
    if (!bootstrapped) return;
    void ipc.onboarding
      .getStatus()
      .then((r) => setObStatus(r.status))
      .catch(() => undefined);
  }, [bootstrapped, obCheck]);

  // 向导收尾（完成或跳过）：重拉 status + workspaces——完成→ws 非空进 MainShell；
  // 跳过→status=skipped 落回原空态表单
  const onWizardFinished = useCallback(() => {
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

  if (workspaces.length === 0) {
    // 首启空态（spec 2026-10-10 §3.1）：引导 pending → 向导接管；skipped/completed
    // → 原空态（TitleBar + 内嵌创建表单）。创建成功后 store 写入 workspace →
    // 分支翻转进 MainShell。onClose 重新拉取列表兜底（仍为空则表单保持）。
    // 注：升级提示不在首启空态渲染——新装用户无标记；纯 2.0 新装命中此分支无需告知。
    if (obStatus === 'pending') {
      return <OnboardingWizard onFinished={onWizardFinished} />;
    }
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
        <TitleBar />
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <CreateWorkspaceDialog onClose={() => void load()} embedded />
        </div>
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
