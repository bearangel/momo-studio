// renderer/src/components/agent/RegisterMcpDialog.tsx
// v1.6 Task 13：表单式注册自定义 MCP server 弹窗。
//
// 字段：名称* / 版本 / 命令* / 参数（逗号分隔）/ 环境变量（多行 KEY=VALUE，[+] 加行）
// 提交流程：
//   1. args = params.split(',').map(trim).filter(Boolean)
//   2. env = Object.fromEntries(envRows 过滤空行后按首个 '=' 拆键值)
//   3. await ipc.mcp.register({ id: crypto.randomUUID(), name, version, command, args, env, source: 'custom' })
//   4. await ipc.mcp.start(activeWorkspaceId, name)
//   5. onSuccess() 通知父组件刷新列表 → onClose() 关闭弹窗
//
// 约束：
//   - source 显式 'custom'（被 T6 的 deleteRegistered 接受；marketplace 装的会 reject）
//   - 提交期间按钮 disabled（防双击）
//   - 失败 → 红字错误显示在表单底部，弹窗保持打开
import { useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface Props {
  onClose: () => void;
  /** 注册并启动成功后调用（父组件据此刷新已注册 MCP 列表） */
  onSuccess: () => void;
}

/**
 * 把多行 "KEY=VALUE" 字符串数组解析为 env 对象。
 * 按首个 '=' 拆分（值里允许出现 '='）；空行与无 '=' 的行跳过。
 */
function parseEnv(rows: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of rows) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 无 '=' 或 key 为空 → 跳过
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key) env[key] = value;
  }
  return env;
}

export function RegisterMcpDialog({ onClose, onSuccess }: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  // env 行：初始一行空串，[+] 按钮追加
  const [envRows, setEnvRows] = useState<string[]>(['']);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    if (!activeWorkspaceId) {
      setError('未激活的工作空间，无法启动 MCP');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const parsedArgs = args
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const env = parseEnv(envRows);
      // 注册定义（source 显式 'custom' 才能被 deleteRegistered 接受）
      await ipc.mcp.register({
        id: crypto.randomUUID(),
        name: name.trim(),
        version: version.trim(),
        command: command.trim(),
        args: parsedArgs,
        env,
        source: 'custom',
      });
      // 在当前 workspace 启动该 MCP 进程（进程池复用）
      await ipc.mcp.start(activeWorkspaceId, name.trim());
      onSuccess();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">注册自定义 MCP server</h2>
        <div className="flex flex-col gap-3">
          <Input
            label="名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：github"
          />
          <Input
            label="版本"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="如：1.0.0（可选）"
          />
          <Input
            label="命令"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="如：npx"
          />
          <Input
            label="参数"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="逗号分隔，如：-y, server.js, --port 3000"
          />

          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">环境变量</label>
            {envRows.map((row, idx) => (
              <input
                key={idx}
                type="text"
                value={row}
                onChange={(e) => {
                  const next = [...envRows];
                  next[idx] = e.target.value;
                  setEnvRows(next);
                }}
                placeholder="KEY=VALUE"
                className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none"
              />
            ))}
            <button
              type="button"
              onClick={() => setEnvRows((rows) => [...rows, ''])}
              className="self-start text-xs px-2 py-1 rounded-md text-accent-blue hover:bg-bg-tertiary"
              aria-label="+"
            >
              + 添加环境变量
            </button>
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={submitting || !name.trim() || !command.trim()}>
              {submitting ? '注册中…' : '注册并启动'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
