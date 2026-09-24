// renderer/src/components/resource-library/McpJsonPasteDialog.tsx
// MCP JSON 批量导入（spec §4.2）：导入 → 解析预览（含同名覆盖确认）→ 逐条注册 → 结果摘要。
// 后端 registerMcp 为 INSERT OR REPLACE——覆盖语义必须在 UI 显式确认。
// 阶段机：input → review → importing → done。
//   - review 阶段同时展示冲突数（与已安装 mcp 按 slug=mcp name 比对）
//   - importing 阶段逐条 await；顺序执行（写库不并发），失败累加到 failures
//   - done 阶段：成功/失败分别统计；只要至少一条成功就触发 onSuccess（父级刷新）
// P2.4（spec §6.2）：弹窗更名「导入 JSON」+ 一键插入结构化示例（非空输入二段确认替换）
// + 远程条目 headers 透传（导入后可在「配置」里替换占位 key）。
// P2.5（spec ①②③/D1-D3）：弹窗加宽 640 / textarea 14 行；done 阶段二态——
//   全成功 → 直写 installNotice 横幅（TypePageShell 既有渲染）+ 自动关弹窗；
//   部分失败 → 留窗展示失败明细（不横幅化，等用户手动处理）。
import { useState } from 'react';
import { ipc } from '../../ipc/client';
import type { ParsedMcpEntry } from '../../lib/mcp-json';
import { parseMcpServersJson } from '../../lib/mcp-json';
import { useResourceStore } from '../../stores/resource.store';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

/** 结构化多行示例（spec §6.2）：stdio + 带 headers 远程各一条；key 用占位符 */
const EXAMPLE_JSON = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    },
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "Authorization": "Bearer <你的 API Key>" }
    }
  }
}`;

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
  // 插入示例二段确认态：非空输入首次点击只亮「确认替换」，再点才覆盖
  const [confirmReplace, setConfirmReplace] = useState(false);

  /** 插入示例：空输入直接填入；非空二段确认（与同名覆盖确认同模式） */
  const insertExample = (): void => {
    if (text.trim() === '') {
      setText(EXAMPLE_JSON);
      setConfirmReplace(false);
      return;
    }
    if (!confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setText(EXAMPLE_JSON);
    setConfirmReplace(false);
  };

  const handleParse = async (): Promise<void> => {
    setError(null);
    try {
      const entries = parseMcpServersJson(text);
      // 同名预检：与已注册 mcp 比对（slug 即 mcp name）
      const installed = await ipc.resource.list({ type: 'mcp' });
      const names = new Set(installed.map((i) => i.slug));
      const conflicts = entries.map((e) => e.name).filter((n) => names.has(n));
      setConfirmReplace(false);
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
          // 二态转发（P2 转正）：url 条目按 streamable_http 注册，本地条目缺省 stdio
          transport: entry.url ? 'streamable_http' : undefined,
          url: entry.url,
          // P2.4：远程条目请求头透传（导入后可在「配置」里改 key）
          headers: entry.headers,
        });
        ok += 1;
      } catch (err) {
        failures.push({ name: entry.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    setPhase({ kind: 'done', ok, failures });
    if (ok > 0) onSuccess();
    // P2.5 D3：全部成功 → 横幅 + 自动关（弹窗内直写 store，与 View 层 handleMcpConfigSubmit 同模式）。
    // 解析器对空对象直接抛错（review 阶段必 ≥1 条），failures 为空即 ok ≥ 1，无「0 条成功」误横幅路径。
    if (failures.length === 0) {
      useResourceStore.setState({ installNotice: `导入成功 ${ok} 条 MCP` });
      onClose();
    }
  };

  return (
    // 容器可访问名与 textarea aria-label「导入 JSON」区分（否则 getByLabelText 撞名）
    <Dialog open onClose={onClose} title="导入 JSON" ariaLabel="批量导入 MCP" width={640}>
      <div className="flex flex-col gap-3">
        {phase.kind === 'input' && (
          <>
            <label htmlFor="mcp-json-input" className="text-sm text-secondary">
              导入 JSON（支持 mcpServers / servers（VS Code）/ 裸对象；远程条目写 url，须 https；导入后可在「配置」里替换占位 key）
            </label>
            <textarea
              id="mcp-json-input"
              aria-label="导入 JSON"
              rows={14}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='支持 mcpServers / VS Code servers / 裸对象'
              className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[12.5px] font-mono text-primary focus:border-focus focus:outline-none resize-y"
            />
            {error && <div className="text-status-error text-sm break-all">{error}</div>}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={insertExample}
                className="rounded-md px-2 py-1 text-xs text-accent-600 hover:bg-surface-3 dark:text-accent-300"
              >
                {confirmReplace ? '确认替换' : '插入示例'}
              </button>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
                <Button type="button" disabled={!text.trim()} onClick={() => void handleParse()}>解析</Button>
              </div>
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
                  {/* 远程/本地徽标：tone 与来源徽标同语义分组（网络源 violet / 本地 neutral） */}
                  <Badge tone={e.url ? 'violet' : 'neutral'}>{e.url ? '远程' : '本地'}</Badge>
                  <code className="text-tertiary truncate">
                    {e.url ?? `${e.command} ${(e.args ?? []).join(' ')}`.trim()}
                  </code>
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
