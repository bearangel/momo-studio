// renderer/src/components/settings/HubSettingsPanel.tsx
//
// 设置「节点互联」面板（momo-hub M0 Task 11 三态底座 + M2.1 Task 5 瘦身，视觉合同
// .omo/previews/hub-ia-fullapp.html S5「瘦身为纯配置」）：
// - 迁移说明卡（已接入态首块）：工作组日常操作（组/镜像/委派/查看）已移至主界面
//   「工作组」，「前往 →」setActiveView('workgroups')——GroupPanel 及其挂载的
//   MirrorWizard/DelegationWizard/DelegationPanel/ViewPanel 全部随 T5 退役
// - 态 1 未接入：接入表单（hub 地址 / 节点名〔helper〕/ 加入凭证〔password + helper〕）+
//   主按钮「接入」（表单逻辑收敛复用 useHubEnroll hook——T2 自本组件抽出）
// - 态 2 已接入·已连接：绿点徽章 + 信息行（hub 地址 / 本机节点名 + nodeId 8 位短码）+
//   在线节点列表 + 隐私与受控（委派接受/远程查看同意两开关）+ 危险区「断开并忘记」两步确认
// - 态 3 已接入·连接中断：黄点「连接中」徽章 + lastError 原文行 + 自动重连提示 + 列表降级灰点占位
// - 换址重接（configured && nodeId === null，主进程换址清凭证归零）：提示行 + 预填表单
// - 换址入口（D1，已接入态）：身份区次级按钮「修改 hub 地址」→ 确认弹窗（改地址 + 断开告警）
//   → 调 configure → 落到换址引导态
import { useEffect, useState } from 'react';
import { Network, RefreshCw, Trash2, Users } from 'lucide-react';
import { useHubEnroll } from '../../hooks/use-hub-enroll';
import { useHubStore } from '../../stores/hub.store';
import { useUiStore } from '../../stores/ui.store';
import { ipc } from '../../ipc/client';
import type { HubConnectionState, HubDelegationSettings, HubStatus, HubViewSettings } from '../../ipc/types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';

/**
 * 委派子节点区段（M2e T10，RM2-3 复用表单豁免——Switch/Input 既有原子）：
 * 接受开关（即时保存）+ 并发上限（失焦/回车保存，主进程夹取 [1,8] 后回显）。
 */
function DelegationSection() {
  const [settings, setSettings] = useState<HubDelegationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [concurrencyDraft, setConcurrencyDraft] = useState('');

  useEffect(() => {
    void ipc.hub
      .getDelegationSettings()
      .then((s) => {
        setSettings(s);
        setConcurrencyDraft(String(s.maxConcurrent));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (settings === null) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium text-primary">任务委派（子节点）</div>
        {error !== null ? (
          <p className="text-xs text-status-error" role="alert">{error}</p>
        ) : (
          <p className="text-xs text-tertiary">加载中…</p>
        )}
      </div>
    );
  }

  const save = async (next: HubDelegationSettings): Promise<void> => {
    setError(null);
    try {
      const normalized = await ipc.hub.setDelegationSettings(next);
      setSettings(normalized);
      setConcurrencyDraft(String(normalized.maxConcurrent));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-primary">任务委派（子节点）</div>
      <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 p-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] text-primary">接受其他节点派来的任务</div>
            <p className="text-xs text-tertiary">关闭后新委派一律婉拒（declined）；已在本机运行的任务不受影响</p>
          </div>
          <Switch
            checked={settings.acceptTasks}
            onChange={(next) => void save({ ...settings, acceptTasks: next })}
            aria-label="接受任务委派"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] text-primary">并发上限</div>
            <p className="text-xs text-tertiary">同时执行的委派任务数（1-8，超出婉拒）</p>
          </div>
          <Input
            type="number"
            min={1}
            max={8}
            className="w-20"
            value={concurrencyDraft}
            onChange={(e) => setConcurrencyDraft(e.target.value)}
            onBlur={() => {
              const n = Number(concurrencyDraft);
              if (Number.isFinite(n) && n !== settings.maxConcurrent) {
                void save({ ...settings, maxConcurrent: n });
              }
            }}
            aria-label="并发上限"
          />
        </div>
        {error !== null && <p className="text-xs text-status-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}


/**
 * 远程查看同意区段（M2e T14/T15，spec §5.5 双层同意节点层，RM2-3 复用 Switch 豁免）：
 * 「允许本组查看」开关（默认开）——即时保存 + 主进程即时上报 hub（离线由重连重报兜底）。
 */
function ViewConsentSection() {
  const [settings, setSettings] = useState<HubViewSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.hub
      .getViewSettings()
      .then(setSettings)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (settings === null) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium text-primary">远程查看（子节点）</div>
        {error !== null ? (
          <p className="text-xs text-status-error" role="alert">{error}</p>
        ) : (
          <p className="text-xs text-tertiary">加载中…</p>
        )}
      </div>
    );
  }

  const save = async (next: HubViewSettings): Promise<void> => {
    setError(null);
    try {
      setSettings(await ipc.hub.setViewSettings(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-primary">远程查看（子节点）</div>
      <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 p-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] text-primary">允许本组查看</div>
            <p className="text-xs text-tertiary">关闭后，同组组长对本机的远程查看请求将被拒绝（403）；已建立的尾部订阅随之停发</p>
          </div>
          <Switch
            checked={settings.allowGroupView}
            onChange={(next) => void save({ allowGroupView: next })}
            aria-label="允许本组查看"
          />
        </div>
        {error !== null && <p className="text-xs text-status-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}


/** 状态徽章三态：6px 圆点 + 12px medium 文字（已连接绿 / 连接中黄 / 未连接灰） */
const CONN_META: Record<HubConnectionState, { label: string; text: string; dot: string }> = {
  online: { label: '已连接', text: 'text-status-success', dot: 'bg-status-success' },
  connecting: { label: '连接中', text: 'text-status-warning', dot: 'bg-status-warning' },
  disconnected: { label: '未连接', text: 'text-tertiary', dot: 'bg-disabled' },
};

function ConnBadge({ state }: { state: HubConnectionState }) {
  const meta = CONN_META[state];
  return (
    <span className={`mt-1 inline-flex shrink-0 items-center gap-2 text-xs font-medium ${meta.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}

/** nodeId 短码（预览定值：8 位等宽 tertiary） */
function shortNodeId(nodeId: string): string {
  return nodeId.slice(0, 8);
}

export function HubSettingsPanel() {
  const status = useHubStore((s) => s.status);
  const loadError = useHubStore((s) => s.loadError);
  const init = useHubStore((s) => s.init);
  const refresh = useHubStore((s) => s.refresh);

  useEffect(() => init(), [init]);

  if (status === null) {
    if (loadError !== null) {
      // 快照失败态：错误行 + 重试（不留在「加载中」死滞；标题保留上下文）
      return (
        <section className="flex max-w-[560px] flex-col gap-6" aria-label="节点互联设置">
          <div>
            <h2 className="mb-1 flex items-center gap-2 text-base font-medium text-primary">
              <Network size={16} strokeWidth={1.75} aria-hidden />
              节点互联
            </h2>
            <p className="text-sm text-secondary">连接 momo-hub 中心服务，跨设备同步资源与任务。</p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-status-error" role="alert">
              {loadError}
            </p>
            <div>
              <Button size="sm" onClick={refresh}>
                重试
              </Button>
            </div>
          </div>
        </section>
      );
    }
    return <div className="p-4 text-sm text-secondary">加载中...</div>;
  }

  const needsReenroll = status.configured && status.nodeId === null;
  return needsReenroll || !status.configured ? (
    <EnrollForm needsReenroll={needsReenroll} />
  ) : (
    <EnrolledView status={status} />
  );
}

function EnrollForm({ needsReenroll }: { needsReenroll: boolean }) {
  // 表单逻辑收敛复用 useHubEnroll（T2 抽出，供工作组空态与设置页双消费——单源）
  const form = useHubEnroll();

  return (
    <section className="flex max-w-[560px] flex-col gap-6" aria-label="节点互联设置">
      <div>
        <h2 className="mb-1 flex items-center gap-2 text-base font-medium text-primary">
          <Network size={16} strokeWidth={1.75} aria-hidden />
          节点互联
        </h2>
        <p className="text-sm text-secondary">连接 momo-hub 中心服务，跨设备同步资源与任务。</p>
      </div>

      {needsReenroll && (
        <p className="text-xs text-status-warning">地址已变更，需重新接入</p>
      )}

      <form className="flex max-w-[460px] flex-col gap-4" onSubmit={form.submit}>
        <Input
          label="hub 地址"
          className="w-full font-mono text-[12.5px]"
          value={form.hubUrl}
          onChange={(e) => form.setHubUrl(e.target.value)}
          placeholder="https://hub.example.com:8787"
        />
        <div className="flex flex-col gap-1">
          <Input
            label="节点名"
            className="w-full"
            value={form.nodeName}
            onChange={(e) => form.setNodeName(e.target.value)}
            placeholder="办公室 MacBook"
          />
          <p className="text-xs text-tertiary">本机识别名，将展示给其他节点</p>
        </div>
        <div className="flex flex-col gap-1">
          <Input
            label="加入凭证"
            type="password"
            className="w-full font-mono text-[12.5px]"
            value={form.enrollmentToken}
            onChange={(e) => form.setEnrollmentToken(e.target.value)}
            placeholder="join-xxxx-xxxx"
          />
          <p className="text-xs text-tertiary">在 hub 启动横幅中获取</p>
        </div>
        <div>
          <Button type="submit" disabled={form.submitting}>
            接入
          </Button>
        </div>
        {form.error !== null && (
          <p className="text-xs text-status-error" role="alert">
            {form.error}
          </p>
        )}
      </form>
    </section>
  );
}

/** 迁移说明卡（S5 首块，surface-active callout）：工作组日常操作迁出指引，「前往 →」切一等视图 */
function MigrationCard() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg bg-surface-active px-3 py-2.5 text-[13px] text-secondary"
      aria-label="迁移说明"
    >
      <Users
        size={16}
        strokeWidth={1.75}
        aria-hidden
        className="mt-0.5 shrink-0 text-accent-600 dark:text-accent-300"
      />
      <span>
        工作组日常操作（组 / 镜像 / 委派 / 查看）已移至主界面「工作组」。
        <Button
          variant="ghost"
          size="sm"
          className="ml-1 h-auto px-0.5 align-baseline text-accent-600 dark:text-accent-300"
          onClick={() => setActiveView('workgroups')}
        >
          前往 →
        </Button>
      </span>
    </div>
  );
}

function EnrolledView({ status }: { status: HubStatus }) {
  const nodes = useHubStore((s) => s.nodes);
  const forget = useHubStore((s) => s.forget);
  const configure = useHubStore((s) => s.configure);
  const [confirming, setConfirming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  // 换址（D1）：已接入态改 hub 地址——确认后调 configure，主进程清凭证归零 nodeId
  const [readdrOpen, setReaddrOpen] = useState(false);
  const [readdrUrl, setReaddrUrl] = useState('');
  const [readdrSubmitting, setReaddrSubmitting] = useState(false);
  const [readdrError, setReaddrError] = useState<string | null>(null);

  // 确认态 3s 自动回落（预览备注 §5.5：防 armed 态滞留成新的误触入口）
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const nodeId = status.nodeId ?? '';
  // 本机行由状态快照合成（hub 侧 hello 快照只播对端节点）；其余行排除本机 id，
  // hub 回显自己也不双行
  const others = nodes.filter((n) => n.nodeId !== nodeId);
  const rows: Array<{ nodeId: string; nodeName: string; self: boolean }> = [
    ...(nodeId !== ''
      ? [{ nodeId, nodeName: status.nodeName ?? '', self: true }]
      : []),
    ...others.map((n) => ({ nodeId: n.nodeId, nodeName: n.nodeName, self: false })),
  ];
  const online = status.state === 'online';
  const showError = status.lastError !== null && status.state !== 'online';

  const doForget = async (): Promise<void> => {
    setForgetting(true);
    try {
      await forget();
      setConfirming(false);
      setForgetError(null);
    } catch (err) {
      setForgetError(err instanceof Error ? err.message : String(err));
      // 失败回退首击态——重试须重新两步确认
      setConfirming(false);
    } finally {
      setForgetting(false);
    }
  };

  const openReaddr = (): void => {
    setReaddrUrl(status.hubUrl ?? '');
    setReaddrError(null);
    setReaddrOpen(true);
  };

  const submitReaddr = async (): Promise<void> => {
    if (readdrSubmitting) return;
    setReaddrSubmitting(true);
    setReaddrError(null);
    try {
      await configure({ hubUrl: readdrUrl.trim(), nodeName: status.nodeName ?? '' });
      setReaddrOpen(false);
    } catch (err) {
      setReaddrError(err instanceof Error ? err.message : String(err));
    } finally {
      setReaddrSubmitting(false);
    }
  };

  return (
    <section className="flex max-w-[560px] flex-col gap-6" aria-label="节点互联设置">
      <MigrationCard />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 flex items-center gap-2 text-base font-medium text-primary">
            <Network size={16} strokeWidth={1.75} aria-hidden />
            节点互联
          </h2>
          <p className="text-sm text-secondary">连接 momo-hub 中心服务，跨设备同步资源与任务。</p>
        </div>
        <ConnBadge state={status.state} />
      </div>

      {(showError || status.state === 'connecting') && (
        <div className="flex flex-col gap-1">
          {showError && status.lastError !== null && (
            <p className="text-xs text-status-error" role="alert">
              {status.lastError}
            </p>
          )}
          {status.state === 'connecting' && (
            <p className="flex items-center gap-1.5 text-xs text-secondary">
              <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
              自动重连中，恢复后将自动回到已连接
            </p>
          )}
        </div>
      )}

      <div className="divide-y divide-subtle">
        <div className="flex min-h-8 items-center gap-4">
          <span className="w-[88px] shrink-0 text-[13px] text-secondary">hub 地址</span>
          <span className="font-mono text-[13px] text-primary">{status.hubUrl}</span>
        </div>
        <div className="flex min-h-8 items-center gap-4">
          <span className="w-[88px] shrink-0 text-[13px] text-secondary">本机节点</span>
          <span className="text-[13px] text-primary">
            {status.nodeName}
            <span className="ml-2 font-mono text-[12.5px] text-tertiary">
              {shortNodeId(nodeId)}
            </span>
          </span>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={openReaddr}>
          修改 hub 地址
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-primary">在线节点</span>
          {online && <span className="text-xs text-tertiary">{rows.length} 台</span>}
        </div>
        <ul className="divide-y divide-subtle rounded-lg border border-subtle bg-surface-1">
          {online ? (
            rows.map((n) => (
              <li
                key={n.nodeId}
                className="flex min-h-9 items-center gap-2.5 px-3 py-2 text-[13px] text-primary"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-success" aria-hidden />
                {n.nodeName}
                {n.self && <Badge className="ml-0.5">本机</Badge>}
                <span className="ml-auto font-mono text-[12.5px] text-tertiary">
                  {shortNodeId(n.nodeId)}
                </span>
              </li>
            ))
          ) : (
            <li className="flex min-h-9 items-center gap-2.5 px-3 py-2 text-[13px] text-tertiary">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-disabled" aria-hidden />
              连接中断——在线节点列表暂停更新
            </li>
          )}
        </ul>
        {online && (
          <p className="text-xs text-tertiary">
            在线状态在连接时同步——连接成功时随 hub 在线快照一并更新，之后随上下线通知实时刷新
          </p>
        )}
      </div>

      <DelegationSection />

      <ViewConsentSection />

      <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface-2 p-3">
        <div className="text-sm">
          <span className="text-tertiary">断开与忘记：</span>
          <span className="text-xs text-secondary">
            移除本机接入配置与凭证；hub 节点列表中将不再出现本机
          </span>
        </div>
        {forgetError !== null && (
          <p className="text-xs text-status-error" role="alert">
            {forgetError}
          </p>
        )}
        {confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="danger" size="sm" disabled={forgetting} onClick={() => void doForget()}>
              {forgetting ? '断开中…' : '再次点击确认'}
            </Button>
            <span className="text-xs text-status-warning">
              将删除本机的接入凭证与配置，不可恢复
            </span>
          </div>
        ) : (
          <Button
            variant="danger-outline"
            size="sm"
            className="w-fit"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden />
            断开并忘记
          </Button>
        )}
      </div>

      <Dialog
        open={readdrOpen}
        onClose={() => setReaddrOpen(false)}
        title="修改 hub 地址"
        width={420}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-status-warning">修改地址后将断开并需要重新接入</p>
          <Input
            label="新 hub 地址"
            className="w-full font-mono text-[12.5px]"
            value={readdrUrl}
            onChange={(e) => setReaddrUrl(e.target.value)}
            placeholder="https://hub.example.com:8787"
          />
          {readdrError !== null && (
            <p className="text-xs text-status-error" role="alert">
              {readdrError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReaddrOpen(false)}>
              取消
            </Button>
            <Button
              disabled={readdrSubmitting || readdrUrl.trim() === ''}
              onClick={() => void submitReaddr()}
            >
              {readdrSubmitting ? '提交中…' : '确认修改'}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
