// renderer/src/components/settings/HubSettingsPanel.tsx
//
// 设置「节点互联」面板（momo-hub M0 Task 11）——实现对照已批预览
// .superpowers/sdd/2026-10-23-momo-hub-m0-connection-foundation/task-11-preview.html 三态：
// - 态 1 未接入：接入表单（hub 地址 / 节点名〔helper〕/ 加入凭证〔password + helper〕）+ 主按钮「接入」
// - 态 2 已接入·已连接：绿点徽章 + 信息行（hub 地址 / 本机节点名 + nodeId 8 位短码）+
//   在线节点列表（绿点 + 名称 +「本机」Badge + 右对齐短码）+ M1/M2 禁用说明行 +
//   危险区「断开并忘记」两步确认（首击描边→danger 填充「再次点击确认」——ProviderModelPicker 范式）
// - 态 3 已接入·连接中断：黄点「连接中」徽章 + lastError 原文行 + 自动重连提示 + 列表降级灰点占位
// - 换址重接（configured && nodeId === null，主进程换址清凭证归零）：提示行 + 预填表单
import { useEffect, useState, type FormEvent } from 'react';
import { Files, Network, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useHubStore } from '../../stores/hub.store';
import type { HubConnectionState, HubStatus } from '../../ipc/types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

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
  const init = useHubStore((s) => s.init);

  useEffect(() => init(), [init]);

  if (status === null) {
    return <div className="p-4 text-sm text-secondary">加载中...</div>;
  }

  const needsReenroll = status.configured && status.nodeId === null;
  return needsReenroll || !status.configured ? (
    <EnrollForm status={status} needsReenroll={needsReenroll} />
  ) : (
    <EnrolledView status={status} />
  );
}

function EnrollForm({ status, needsReenroll }: { status: HubStatus; needsReenroll: boolean }) {
  const enroll = useHubStore((s) => s.enroll);
  // 换址重接场景预填当前 hubUrl/节点名；未接入初始为空（分支只在快照落地后渲染，初值即定值）
  const [hubUrl, setHubUrl] = useState(status.hubUrl ?? '');
  const [nodeName, setNodeName] = useState(status.nodeName ?? '');
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await enroll({
        hubUrl: hubUrl.trim(),
        enrollmentToken: enrollmentToken.trim(),
        nodeName: nodeName.trim(),
      });
      // 成功后 store 已覆盖 status → 面板切已接入视图，本组件随分支卸载
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

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

      <form className="flex max-w-[460px] flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
        <Input
          label="hub 地址"
          className="w-full font-mono text-[12.5px]"
          value={hubUrl}
          onChange={(e) => setHubUrl(e.target.value)}
          placeholder="https://hub.example.com:8787"
        />
        <div className="flex flex-col gap-1">
          <Input
            label="节点名"
            className="w-full"
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder="办公室 MacBook"
          />
          <p className="text-xs text-tertiary">本机识别名，将展示给其他节点</p>
        </div>
        <div className="flex flex-col gap-1">
          <Input
            label="加入凭证"
            type="password"
            className="w-full font-mono text-[12.5px]"
            value={enrollmentToken}
            onChange={(e) => setEnrollmentToken(e.target.value)}
            placeholder="join-xxxx-xxxx"
          />
          <p className="text-xs text-tertiary">在 hub 启动横幅中获取</p>
        </div>
        <div>
          <Button type="submit" disabled={submitting}>
            接入
          </Button>
        </div>
        {error !== null && (
          <p className="text-xs text-status-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function EnrolledView({ status }: { status: HubStatus }) {
  const nodes = useHubStore((s) => s.nodes);
  const forget = useHubStore((s) => s.forget);
  const [confirming, setConfirming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);

  // 确认态 3s 自动回落（预览备注 §5.5：防 armed 态滞留成新的误触入口）
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const nodeId = status.nodeId ?? '';
  // 本机行由快照合成（M0 hello 的 onlineNodes 不下发 renderer，列表纯事件增量——
  // 冷启动时本机行也要在场）；其余行排除本机 id，hub 回显自己也不双行
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

  return (
    <section className="flex max-w-[560px] flex-col gap-6" aria-label="节点互联设置">
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
            在线状态由 hub 上线通知驱动——面板打开后新上线的节点才会出现（M0 冷启动限制）
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface-1 p-3">
        <div className="flex items-center gap-2 text-[13px] text-disabled">
          <Send size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
          任务委派——把任务派给其他节点上的 agent
          <Badge className="ml-auto">M1 即将提供</Badge>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-disabled">
          <Files size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
          资源镜像——跨节点同步资源库
          <Badge className="ml-auto">M2 即将提供</Badge>
        </div>
      </div>

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
    </section>
  );
}
