// renderer/src/components/settings/AuditLog.tsx
//
// 工具调用审计日志表格：
//   - 列：时间 | agent | 工具名 | 成功/失败 | 耗时
//   - 按 agent / 工具名筛选（输入框，前端对当前页过滤 + 后端精确筛选二选一；
//     这里用后端精确筛选，保证大数据集分页正确）
//   - 分页：每页 50 条
//
// 数据来自 audit:getToolCalls IPC（→ tool_calls 表，最新优先）。
import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import { type ToolCallRecord } from '../../ipc/types';
import { Button } from '../ui/Button';

interface Props {
  workspaceId: string;
}

const PAGE_SIZE = 50;

export function AuditLog({ workspaceId }: Props) {
  const [records, setRecords] = useState<ToolCallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [agentFilter, setAgentFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');

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

  useEffect(() => {
    void load();
  }, [load]);

  // 切换筛选条件时回到第一页
  function applyFilter(): void {
    setOffset(0);
    void load();
  }

  const hasMore = records.length === PAGE_SIZE;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-neutral-200">审计日志</h3>
        <p className="text-xs text-neutral-500">agent 工具调用记录（每页 {PAGE_SIZE} 条）</p>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-400">agent</span>
          <input
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilter();
            }}
            placeholder="@bot:localhost"
            className="px-2 py-1 text-xs rounded bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none w-44"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-400">工具名</span>
          <input
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilter();
            }}
            placeholder="read_file"
            className="px-2 py-1 text-xs rounded bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none w-44"
          />
        </label>
        <Button size="sm" variant="ghost" onClick={applyFilter}>
          筛选
        </Button>
      </div>

      {error && <div className="text-red-400 text-sm">{error}</div>}

      {/* 表格 */}
      <div className="overflow-auto border border-border-subtle rounded-md max-h-[420px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-bg-secondary text-neutral-400">
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
                <td colSpan={5} className="text-center text-neutral-500 py-6">
                  加载中…
                </td>
              </tr>
            ) : records.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-neutral-500 py-6">
                  暂无审计记录
                </td>
              </tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} className="border-t border-border-subtle hover:bg-bg-tertiary">
                  <td className="px-2 py-1.5 text-neutral-300 whitespace-nowrap">{r.timestamp}</td>
                  <td className="px-2 py-1.5 text-neutral-300 font-mono truncate max-w-[180px]">
                    {r.agentBotUserId}
                  </td>
                  <td className="px-2 py-1.5 text-neutral-200 font-mono">{r.toolName}</td>
                  <td className="px-2 py-1.5">
                    <span
                      className={
                        'px-1.5 py-0.5 rounded ' +
                        (r.success
                          ? 'bg-green-500/15 text-green-400'
                          : 'bg-red-500/15 text-red-400')
                      }
                    >
                      {r.success ? '成功' : '失败'}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-neutral-400 tabular-nums">
                    {r.durationMs}ms
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-between text-xs text-neutral-500">
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
