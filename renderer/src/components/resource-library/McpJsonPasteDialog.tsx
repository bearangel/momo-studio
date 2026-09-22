// renderer/src/components/resource-library/McpJsonPasteDialog.tsx
// MCP JSON 批量导入（spec §4.2）：粘贴 → 解析预览（含同名覆盖确认）→ 逐条注册 → 结果摘要。
// 后端 registerMcp 为 INSERT OR REPLACE——覆盖语义必须在 UI 显式确认。
// 阶段机：input → review → importing → done。
//   - review 阶段同时展示冲突数（与已安装 mcp 按 slug=mcp name 比对）
//   - importing 阶段逐条 await；顺序执行（写库不并发），失败累加到 failures
//   - done 阶段：成功/失败分别统计；只要至少一条成功就触发 onSuccess（父级刷新）
import { useState } from 'react';
import { ipc } from '../../ipc/client';
import type { ParsedMcpEntry } from '../../lib/mcp-json';
import { parseMcpServersJson } from '../../lib/mcp-json';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface Props {
  onClose: () => void;
  /** 全部条目处理完毕（无论部分失败与否）后调用——父组件刷新列表 */
  onSuccess: () => void;
}

type Phase =
  | { kind: 'input' }
  | { kind: 'review'; entries: ParsedMcpEntry[]; conflicts: string[] }
  | { kind: 'importing' }
  | { kind: 'done'; ok: number; failures: Array<{ name: string; reason: string }> };

export function McpJsonPasteDialog({ onClose, onSuccess }: Props) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [error, setError] = useState<string | null>(null);

  const handleParse = async (): Promise<void> => {
    setError(null);
    try {
      const entries = parseMcpServersJson(text);
      // 同名预检：与已注册 mcp 比对（slug 即 mcp name）
      const installed = await ipc.resource.list({ type: 'mcp' });
      const names = new Set(installed.map((i) => i.slug));
      const conflicts = entries.map((e) => e.name).filter((n) => names.has(n));
      setPhase({ kind: 'review', entries, conflicts });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async (): Promise<void> => {
    if (phase.kind !== 'review') return;
    setPhase({ kind: 'importing' });
    let ok = 0;
    const failures: Array<{ name: string; reason: string }> = [];
    // 顺序执行（写库操作不并发；逐条收集错误）
    for (const entry of phase.entries) {
      try {
        await ipc.resource.registerMcp({
          name: entry.name,
          command: entry.command,
          args: entry.args,
          env: entry.env,
        });
        ok += 1;
      } catch (err) {
        failures.push({ name: entry.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    setPhase({ kind: 'done', ok, failures });
    if (ok > 0) onSuccess();
  };

  return (
    <Dialog open onClose={onClose} title="粘贴 JSON 导入 MCP" width={520}>
      <div className="flex flex-col gap-3">
        {phase.kind === 'input' && (
          <>
            <label htmlFor="mcp-json-input" className="text-sm text-secondary">
              粘贴 JSON（支持 {'{ "mcpServers": { … } }'} 或裸 {'{ "名称": { command, args, env } }'}）
            </label>
            <textarea
              id="mcp-json-input"
              aria-label="粘贴 JSON"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "…"] } } }'
              className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[12.5px] font-mono text-primary focus:border-focus focus:outline-none resize-y"
            />
            {error && <div className="text-status-error text-sm break-all">{error}</div>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
              <Button type="button" disabled={!text.trim()} onClick={() => void handleParse()}>解析</Button>
            </div>
          </>
        )}

        {phase.kind === 'review' && (
          <>
            <div className="text-sm text-secondary">待导入 {phase.entries.length} 条：</div>
            <ul className="max-h-52 overflow-y-auto flex flex-col gap-1">
              {phase.entries.map((e) => (
                <li key={e.name} className="text-xs text-secondary bg-surface-2 rounded-md px-2.5 py-1.5 flex items-center gap-2">
                  <span className="font-medium text-primary">{e.name}</span>
                  <code className="text-tertiary truncate">{e.command} {(e.args ?? []).join(' ')}</code>
                </li>
              ))}
            </ul>
            {phase.conflicts.length > 0 && (
              <div className="text-xs text-status-warning">
                将覆盖 {phase.conflicts.length} 个同名服务器：{phase.conflicts.join('、')}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={() => setPhase({ kind: 'input' })}>返回修改</Button>
              <Button type="button" onClick={() => void handleImport()}>确认导入</Button>
            </div>
          </>
        )}

        {phase.kind === 'importing' && <div className="text-sm text-tertiary py-4 text-center">导入中…</div>}

        {phase.kind === 'done' && (
          <>
            <div className="text-sm text-status-success">成功 {phase.ok} 条</div>
            {phase.failures.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-sm text-status-error">失败 {phase.failures.length} 条：</div>
                {phase.failures.map((f) => (
                  <div key={f.name} className="text-xs text-status-error break-all">{f.name}：{f.reason}</div>
                ))}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button type="button" onClick={onClose}>关闭</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
