// renderer/src/components/resource-library/InstallPluginZipDialog.tsx
// 插件 zip 安装弹窗（spec 2026-10-15 §7.2，P1 预览确认稿 §4）：FileReader 读
// ArrayBuffer → Uint8Array → plugin.installZip（contextBridge 下 Node Buffer 跨
// structured clone 会损坏，主进程侧归一）。校验失败错误逐条内联展示不关弹窗。
import { useRef, useState, type ChangeEvent } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

/** FileReader 读 ArrayBuffer（jsdom 未实现 File.arrayBuffer()——UploadSkillDialog 同款约束） */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** 安装锁定期传给 Dialog 的关闭回调（Esc / 遮罩关闭 no-op） */
const noop = (): void => undefined;

export function InstallPluginZipDialog({ onClose, onSuccess }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFile(picked);
    setError(null);
    setSuccessMsg(null);
  };

  const handleInstall = async (): Promise<void> => {
    if (!file || installing) return;
    setInstalling(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const buffer = await readFileAsArrayBuffer(file);
      const summary = await ipc.plugin.installZip(new Uint8Array(buffer), file.name);
      setSuccessMsg(
        `已安装：${summary.name}（${summary.id} v${summary.version}，组件 ${summary.components.length} 项）`,
      );
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open onClose={installing ? noop : onClose} title="安装插件 zip" width={448}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm text-secondary">插件包（.zip）</label>
          <div className="flex gap-2 items-center">
            <Button
              variant="ghost"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={installing}
            >
              选择文件...
            </Button>
            <span className="text-sm text-tertiary truncate flex-1">
              {file ? file.name : '未选择文件'}
            </span>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={handleFileChange}
            className="hidden"
            aria-label="选择文件"
            disabled={installing}
          />
          <p className="text-xs text-tertiary mt-1">
            安装时校验 momo-plugin.json（白名单 / 路径安全 / 组件存在性），通过后落位并注册。
          </p>
        </div>
        {successMsg && (
          <div className="text-status-success text-sm break-all">{successMsg}</div>
        )}
        {error && (
          <div className="text-status-error text-sm whitespace-pre-wrap break-all">{error}</div>
        )}
        <div className="flex gap-2 justify-end mt-1">
          <Button variant="ghost" type="button" onClick={onClose} disabled={installing}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!file || installing}
            onClick={() => void handleInstall()}
          >
            {installing ? '安装中…' : '安装'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
