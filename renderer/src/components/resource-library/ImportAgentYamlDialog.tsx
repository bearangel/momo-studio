// renderer/src/components/resource-library/ImportAgentYamlDialog.tsx
// 导入 Agent YAML（spec §4.1）——复用现有 agent.createFromYaml 通道
// （manifest 解析+校验+落库一体；校验错误含字段名，内联展示不关弹窗）。
import { useRef, useState, type ChangeEvent } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface Props {
  onClose: () => void;
  /** 导入成功后调用（父组件据此刷新已装 agent 列表） */
  onSuccess: () => void;
}

/** FileReader 读文本（jsdom 未实现 File.text()——UploadSkillDialog 同款约束） */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** 导入锁定期传给 Dialog 的关闭回调（Esc / 遮罩关闭 no-op，对齐 UploadSkillDialog 模式） */
const noop = (): void => undefined;

export function ImportAgentYamlDialog({ onClose, onSuccess }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFile(picked);
    setError(null);
    setSuccessMsg(null);
  };

  const handleImport = async (): Promise<void> => {
    if (!file || importing) return;
    setImporting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const yaml = await readFileAsText(file);
      const def = await ipc.agent.createFromYaml(yaml);
      setSuccessMsg(`已导入：${def.name}（${def.slug}）`);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open onClose={importing ? noop : onClose} title="导入 Agent YAML" width={448}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm text-secondary">Agent manifest 文件（.yaml / .yml）</label>
          <div className="flex gap-2 items-center">
            <Button variant="ghost" type="button" onClick={() => inputRef.current?.click()} disabled={importing}>
              选择文件...
            </Button>
            <span className="text-sm text-tertiary truncate flex-1">{file ? file.name : '未选择文件'}</span>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".yaml,.yml,.txt"
            onChange={handleFileChange}
            className="hidden"
            aria-label="选择文件"
            disabled={importing}
          />
          <p className="text-xs text-tertiary mt-1">
            K8s 风格 manifest（apiVersion: v1 / kind: AgentDefinition / metadata / spec.declarative），
            校验失败会逐条列出字段问题。
          </p>
        </div>
        {successMsg && <div className="text-status-success text-sm break-all">{successMsg}</div>}
        {error && <div className="text-status-error text-sm whitespace-pre-wrap break-all">{error}</div>}
        <div className="flex gap-2 justify-end mt-1">
          <Button variant="ghost" type="button" onClick={onClose} disabled={importing}>取消</Button>
          <Button type="button" disabled={!file || importing} onClick={() => void handleImport()}>
            {importing ? '导入中…' : '导入'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
