// renderer/src/components/settings/AuditLog.tsx
//
// 工具调用审计日志面板：
//   - 顶部配额卡（P2 Task 8）：本空间上限 MB 输入（空=继承全局）+
//     当前占用进度条 + 立即清理按钮（显示删除条数反馈）
//   - 列：时间 | agent | 工具名 | 成功/失败 | 耗时
//   - 按 agent / 工具名筛选（输入框，前端对当前页过滤 + 后端精确筛选二选一；
//     这里用后端精确筛选，保证大数据集分页正确）
//   - 分页：每页 50 条
//
// 数据来自 audit:getToolCalls / audit:getQuota / audit:setQuota / audit:enforceNow IPC。
import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import { type AuditQuotaInfo, type ToolCallRecord } from '../../ipc/types';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';

interface Props {
  workspaceId: string;
}

const PAGE_SIZE = 50;

/** 字节数人性化显示：1024 进制，保留 1 位小数（26214400 → '25.0 MB'） */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function AuditLog({ workspaceId }: Props) {
  const [records, setRecords] = useState<ToolCallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [agentFilter, setAgentFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [quotaInfo, setQuotaInfo] = useState<AuditQuotaInfo | null>(null);
  const [quotaInput, setQuotaInput] = useState('');
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [enforcing, setEnforcing] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await ipc.audit.getToolCalls(workspaceId, {
        limit: PAGE_SIZE,
        offset,
        agentBotUserId: agentFilter.trim() || undefined,
        toolName: toolFilter.trim() || undefined,
      });
      setRecords(rows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, offset, agentFilter, toolFilter]);

  const loadQuota = useCallback(async () => {
    try {
      setQuotaInfo(await ipc.audit.getQuota(workspaceId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setQuotaInput('');
    setQuotaError(null);
    setCleanupMsg(null);
    void loadQuota();
  }, [loadQuota]);

  /** 保存上限：空输入 = 清除覆盖（回退全局）；非正数本地拦截报错 */
  async function saveQuota(): Promise<void> {
    const trimmed = quotaInput.trim();
    let quotaMb: number | null = null;
    if (trimmed !== '') {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) {
        setQuotaError('上限必须为正数（MB）');
        return;
      }
      quotaMb = n;
    }
    setQuotaSaving(true);
    try {
      await ipc.audit.setQuota(workspaceId, quotaMb);
    } catch (err) {
      setQuotaError((err as Error).message);
      return;
    } finally {
      setQuotaSaving(false);
    }
    setQuotaError(null);
    setCleanupMsg(null);
    await loadQuota();
  }

  /** 立即清理：enforceNow 后刷新配额 + 表格 */
  async function runCleanup(): Promise<void> {
    setEnforcing(true);
    try {
      const { deletedCount } = await ipc.audit.enforceNow(workspaceId);
      setCleanupMsg(`已清理 ${deletedCount} 条`);
      await Promise.all([loadQuota(), load()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEnforcing(false);
    }
  }

  // 切换筛选条件时回到第一页
  function applyFilter(): void {
    setOffset(0);
    void load();
  }

  const hasMore = records.length === PAGE_SIZE;
  const usedPct =
    quotaInfo && quotaInfo.quotaMb > 0
      ? Math.min(100, (quotaInfo.usedBytes / (quotaInfo.quotaMb * 1024 * 1024)) * 100)
      : 0;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-primary">审计日志</h3>
        <p className="text-xs text-tertiary">agent 工具调用记录（每页 {PAGE_SIZE} 条）</p>
      </div>

      {/* 配额卡：上限 + 占用 + 立即清理 */}
      <div className="border border-subtle rounded-md p-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-secondary">容量上限（MB）</span>
            <input
              value={quotaInput}
              onChange={(e) => setQuotaInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveQuota();
              }}
              placeholder="100=继承全局"
              className="px-2 py-1 text-xs rounded border border-subtle bg-surface-2 text-primary focus:border-focus focus:outline-none w-36"
            />
          </label>
          <Button size="sm" variant="ghost" disabled={quotaSaving} onClick={() => void saveQuota()}>
            保存上限
          </Button>
          <Button size="sm" variant="ghost" disabled={enforcing} onClick={() => void runCleanup()}>
            立即清理
          </Button>
        </div>
        {quotaError && <div className="text-status-error text-xs">{quotaError}</div>}
        {cleanupMsg && <div className="text-status-success text-xs">{cleanupMsg}</div>}
        {quotaInfo && (
          <div className="flex flex-col gap-1">
            <div className="h-2 rounded bg-surface-2 overflow-hidden">
              <div
                data-testid="audit-quota-bar"
                className={cn(
                  'h-2 rounded transition-width',
                  usedPct >= 95 ? 'bg-status-error' : 'bg-accent-500',
                )}
                style={{ width: `${usedPct}%` }}
              />
            </div>
            <span className="text-xs text-tertiary">
              {formatBytes(quotaInfo.usedBytes)} / {quotaInfo.quotaMb} MB · {quotaInfo.rowCount} 条记录
            </span>
          </div>
        )}
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">agent</span>
          <input
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilter();
            }}
            placeholder="@bot:localhost"
            className="px-2 py-1 text-xs rounded border border-subtle bg-surface-2 text-primary focus:border-focus focus:outline-none w-44"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">工具名</span>
          <input
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilter();
            }}
            placeholder="read_file"
            className="px-2 py-1 text-xs rounded border border-subtle bg-surface-2 text-primary focus:border-focus focus:outline-none w-44"
          />
        </label>
        <Button size="sm" variant="ghost" onClick={applyFilter}>
          筛选
        </Button>
      </div>

      {error && <div className="text-status-error text-sm">{error}</div>}

      {/* 表格 */}
      <div className="overflow-auto border border-subtle rounded-md max-h-[420px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-1 text-secondary">
            <tr>
              <th className="text-left font-medium px-2 py-1.5">时间</th>
              <th className="text-left font-medium px-2 py-1.5">Agent</th>
              <th className="text-left font-medium px-2 py-1.5">工具</th>
              <th className="text-left font-medium px-2 py-1.5">结果</th>
              <th className="text-right font-medium px-2 py-1.5">耗时</th>
            </tr>
          </thead>
          <tbody>
            {loading && records.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-tertiary py-6">
                  加载中…
                </td>
              </tr>
            ) : records.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-tertiary py-6">
                  暂无审计记录
                </td>
              </tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} className="border-t border-subtle hover:bg-surface-3">
                  <td className="px-2 py-1.5 text-secondary whitespace-nowrap">{r.timestamp}</td>
                  <td className="px-2 py-1.5 text-secondary font-mono truncate max-w-[180px]">
                    {r.agentBotUserId}
                  </td>
                  <td className="px-2 py-1.5 text-primary font-mono">{r.toolName}</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded',
                        r.success
                          ? 'bg-status-success-tint text-status-success'
                          : 'bg-status-error-tint text-status-error',
                      )}
                    >
                      {r.success ? '成功' : '失败'}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-secondary tabular-nums">
                    {r.durationMs}ms
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-between text-xs text-tertiary">
        <span>
          第 {offset + 1}–{offset + records.length} 条
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            上一页
          </Button>
          <Button size="sm" variant="ghost" disabled={!hasMore || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
            下一页
          </Button>
        </div>
      </div>
    </section>
  );
}
