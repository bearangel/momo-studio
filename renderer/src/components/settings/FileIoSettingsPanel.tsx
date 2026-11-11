// renderer/src/components/settings/FileIoSettingsPanel.tsx
//
// 文件访问设置（spec §5.6）。形态同构 SandboxSettingsPanel（三档 radio +
// 状态卡 + 重新检测）。文案中性化：不出现具体加密产品/白名单/合规字样。
import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ipc } from '../../ipc/client';
import type { FileIoMode, FileIoStatus } from '../../ipc/types';

const MODE_OPTIONS: readonly { value: FileIoMode; label: string; hint: string }[] = [
  { value: 'direct', label: '直接读写（默认）', hint: '应用直接读写本地文件' },
  { value: 'proxy', label: 'Node 代理', hint: '通过 node 代理进程读写文件' },
  { value: 'auto', label: '自动检测', hint: '检测到需要代理的环境时自动启用' },
];

export function FileIoSettingsPanel(): React.ReactElement {
  const [status, setStatus] = useState<FileIoStatus | null>(null);
  const [nodePath, setNodePath] = useState('');
  const [busy, setBusy] = useState(false);
  // 初始加载 / 重探测失败标记（错误路径红线：IPC rejection 不得死滞在「加载中」）
  const [loadError, setLoadError] = useState(false);

  const load = (): Promise<void> =>
    ipc.fileIo
      .getState()
      .then((s) => {
        setStatus(s);
        setNodePath(s.nodePath ?? '');
        setLoadError(false);
      })
      .catch(() => {
        setLoadError(true);
      });

  useEffect(() => {
    void load();
  }, []);

  const save = (mode: FileIoMode): void => {
    if (!status) return;
    setStatus({ ...status, mode });
    // 乐观 UI：保存 fire-and-forget，随后 probe 刷新最终态（与沙箱面板弱一致）
    void ipc.settings
      .updateGlobal({ fileIo: { mode, nodePath: nodePath.trim() || undefined } })
      .catch(() => {});
    void ipc.fileIo.probe().then(setStatus).catch(() => {});
  };

  // nodePath 落库并重探测（onBlur 与「浏览」选择共用；fire-and-forget，同 save 弱一致）
  const persistNodePath = (path: string): void => {
    if (!status) return;
    void ipc.settings
      .updateGlobal({ fileIo: { mode: status.mode, nodePath: path.trim() || undefined } })
      .catch(() => {});
    void ipc.fileIo.probe().then(setStatus).catch(() => {});
  };

  const browseNodePath = async (): Promise<void> => {
    const picked = await ipc.fileIo.pickNodePath();
    if (!picked) return;
    setNodePath(picked);
    persistNodePath(picked);
  };

  const reprobe = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await ipc.fileIo.probe());
      setLoadError(false);
    } catch {
      // 探测失败保留上次状态卡快照；错误提示行复用，重新检测按钮即重试入口
      setLoadError(true);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    if (loadError) {
      return (
        <div className="flex flex-col items-start gap-3 p-4" aria-label="文件访问设置">
          <p className="text-sm text-status-error">加载文件访问设置失败，请重试</p>
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      );
    }
    return <div className="p-4 text-sm text-secondary">加载中...</div>;
  }

  return (
    <section className="flex flex-col gap-6" aria-label="文件访问设置">
      <div>
        <h2 className="mb-1 text-base text-primary">文件访问</h2>
        <p className="text-sm text-secondary">选择应用读写本地文件的方式。</p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">文件访问模式</legend>
        {MODE_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="file-io-mode"
              checked={status.mode === o.value}
              onChange={() => save(o.value)}
              className="mt-1"
              aria-label={o.label}
            />
            {/* label 独立 span：getByText 精确匹配按直接文本子节点拼接——
                与 hint 混排会让裸 label（直接读写（默认）/ Node 代理 / 自动检测）不可查询 */}
            <span>
              <span>{o.label}</span>——{o.hint}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1">
        <div className="flex items-end gap-2">
          <Input
            label="Node.js 路径（可选）"
            className="w-full font-mono text-[12.5px]"
            value={nodePath}
            onChange={(e) => setNodePath(e.target.value)}
            onBlur={() => persistNodePath(nodePath)}
            placeholder="留空 = 自动查找系统 Node.js"
          />
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => void browseNodePath()}
          >
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden />
            浏览
          </Button>
        </div>
      </div>

      {loadError && (
        <p className="text-sm text-status-error">加载文件访问设置失败，请重试</p>
      )}

      <div className="rounded-lg border border-subtle bg-surface-2 p-3 flex flex-col gap-2">
        <div className="text-sm">
          <span className="text-tertiary">代理环境：</span>
          <span className="font-mono text-xs text-secondary">
            {status.clientInstalled ? '已检测到' : '未检测到'}
          </span>
        </div>
        <div className="text-sm">
          <span className="text-tertiary">node.exe：</span>
          <span className="font-mono text-xs text-secondary">
            {status.nodeAvailable ? `可用${status.nodeVersion ? ` (${status.nodeVersion})` : ''}` : '未找到'}
          </span>
        </div>
        <div className="text-sm">
          <span className="text-tertiary">生效模式：</span>
          <span className="font-mono text-xs text-secondary">
            {status.effectiveMode === 'proxy' ? 'Node 代理' : '直接读写'}
          </span>
        </div>
        <Button onClick={() => void reprobe()} disabled={busy}>
          {busy ? '检测中...' : '重新检测'}
        </Button>
      </div>
    </section>
  );
}
