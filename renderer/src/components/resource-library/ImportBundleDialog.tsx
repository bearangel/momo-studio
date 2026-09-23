// renderer/src/components/resource-library/ImportBundleDialog.tsx
// P2.1 Task 6：DXT / MCPB 本地包两阶段导入弹窗（模式照抄 UploadSkillDialog）。
//
// 阶段一（解析）：选文件（accept .dxt/.mcpb/.zip）→ readFileAsArrayBuffer →
//   ipc.resource.parseMcpBundle(buffer, filename) → BundlePreview 预览
// 阶段二（导入）：userConfigSchema 非空则渲染表单（required 缺填禁用导入；
//   sensitive 字段 password 型——BundleConfigField 契约自带，区别于 JsonSchemaLike）
//   → ipc.resource.importMcpBundle(buffer, filename, values) → 成功显示
//   「已导入：{name}（{commandPreview}）」+ onSuccess()（弹窗保留，手动关闭）
//
// tempId 是无状态占位（Task 5 契约）——导入阶段 renderer 持有原文件 buffer
// 二次传参，不回传 tempId（主进程零中间状态）。
//
// 约束：解析 / 导入进行中禁用全部可交互元素（防双击），Esc / 遮罩关闭锁死；
// 换文件即复位回阶段一（需重新解析）；失败红字留在弹窗。
import { useRef, useState, type ChangeEvent } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import type { BundlePreview } from '../../ipc/types';

/**
 * 用 FileReader 把 File 读成 ArrayBuffer。
 * 不能用 file.arrayBuffer()——jsdom 24（单元测试环境）未实现该方法
 * （与 UploadSkillDialog 同一保真度考量）。
 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** serverType 显示标签 */
const SERVER_TYPE_LABEL: Record<BundlePreview['serverType'], string> = {
  node: 'Node.js',
  python: 'Python',
  binary: '二进制',
};

/** 操作锁定期传给 Dialog 的关闭回调（Esc / 遮罩点击 no-op） */
const noop = (): void => undefined;

interface Props {
  onClose: () => void;
  /** 导入成功后调用（父组件据此刷新列表） */
  onSuccess: () => void;
}

export function ImportBundleDialog({ onClose, onSuccess }: Props) {
  const [file, setFile] = useState<File | null>(null);
  // 阶段一产物：原文件 buffer（阶段二复用——主进程重解包方案，tempId 非句柄）
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // 解析 / 导入共用一个忙碌锁（两阶段互斥，防解析中点导入）
  const [busy, setBusy] = useState(false);
  // 隐藏的 input[type=file]，由 [选择文件...] 按钮触发 click
  const inputRef = useRef<HTMLInputElement>(null);

  const configFields = Object.entries(preview?.userConfigSchema ?? {});
  const missingRequired = configFields.some(
    ([name, field]) => field.required === true && !(values[name] ?? '').trim(),
  );
  const lockAll = busy;
  const canParse = file !== null && !busy && !preview;
  // 成功后禁再导入（防重复导入同名包），保留弹窗让用户看到成功消息
  const canImport = preview !== null && buffer !== null && !missingRequired && !busy && !successMsg;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFile(picked);
    // 换文件 → 预览 / 表单 / 提示全部复位（回到阶段一，需重新解析）
    setBuffer(null);
    setPreview(null);
    setValues({});
    setError(null);
    setSuccessMsg(null);
  };

  const handleParse = async (): Promise<void> => {
    if (!file || busy || preview) return;
    setBusy(true);
    setError(null);
    try {
      const buf = await readFileAsArrayBuffer(file);
      const result = await ipc.resource.parseMcpBundle(buf, file.name);
      setBuffer(buf);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (): Promise<void> => {
    if (!file || !buffer || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      // 下发必填 + 非空可选项（Task 5 审查裁定 userConfigSchema 仅含 required 的
      // string 字段；按字段自带 required 防御性校验，空可选项不下发）
      const config: Record<string, string> = {};
      for (const [name, field] of configFields) {
        const v = (values[name] ?? '').trim();
        if (v || field.required === true) config[name] = v;
      }
      await ipc.resource.importMcpBundle(buffer, file.name, config);
      setSuccessMsg(`已导入：${preview.name}（${preview.commandPreview}）`);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={lockAll ? noop : onClose} title="导入 DXT / MCPB 包" width={480}>
      <div className="flex flex-col gap-3">
        {/* 文件选择（两阶段共用一行——换文件即回到阶段一） */}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-secondary">MCP 包文件（.dxt / .mcpb / .zip）</label>
          <div className="flex gap-2 items-center">
            <Button
              variant="ghost"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={lockAll}
            >
              选择文件...
            </Button>
            <span className="text-sm text-tertiary truncate flex-1">
              {file ? file.name : '未选择文件'}
            </span>
          </div>
          {/* 隐藏的文件选择 input。aria-label 让测试可定位 */}
          <input
            ref={inputRef}
            type="file"
            accept=".dxt,.mcpb,.zip"
            onChange={handleFileChange}
            className="hidden"
            aria-label="选择文件"
            disabled={lockAll}
          />
          <p className="text-xs text-tertiary mt-1">
            Anthropic DXT / MCPB 包：解析 manifest 预览元信息与启动命令，user_config
            字段在导入时填入。
          </p>
        </div>

        {/* 阶段二：解析预览 + user_config 表单 */}
        {preview && (
          <>
            <div className="flex flex-col gap-1 rounded-md border border-subtle bg-surface-2 px-3 py-2">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm font-medium text-primary">{preview.displayName}</span>
                <span className="text-xs text-tertiary">{preview.version}</span>
                <span className="text-xs text-tertiary">{SERVER_TYPE_LABEL[preview.serverType]}</span>
              </div>
              {preview.description && (
                <p className="text-xs text-secondary">{preview.description}</p>
              )}
              <p className="font-mono text-xs text-tertiary break-all">{preview.commandPreview}</p>
            </div>
            {configFields.length > 0 && (
              <div className="flex flex-col gap-3">
                {configFields.map(([name, field]) => (
                  <Input
                    key={name}
                    label={field.title ?? name}
                    placeholder={field.description ?? undefined}
                    type={field.sensitive === true ? 'password' : 'text'}
                    value={values[name] ?? ''}
                    disabled={lockAll}
                    onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {successMsg && (
          <div className="text-status-success text-sm break-all">{successMsg}</div>
        )}
        {error && <div className="text-status-error text-sm break-all">{error}</div>}

        <div className="flex gap-2 justify-end mt-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={lockAll}>
            取消
          </Button>
          {preview ? (
            <Button type="button" onClick={handleImport} disabled={!canImport}>
              {busy ? '导入中…' : '导入'}
            </Button>
          ) : (
            <Button type="button" onClick={handleParse} disabled={!canParse}>
              {busy ? '解析中…' : '解析'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
