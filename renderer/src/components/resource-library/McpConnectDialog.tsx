// renderer/src/components/resource-library/McpConnectDialog.tsx
// P2.1 Task 6：Smithery 连接配置弹窗——resource:install 返回 needsConfig:true 后
// 按 configSchema（JsonSchemaLike）收集用户配置，提交走 onSubmit（View 层接线
// ipc.resource.installSmitheryRemote）。
//
// 契约要点（勿扩）：
//   - JsonSchemaLike.properties 仅 title/description/x-from 三字段——无 sensitive
//     语义，输入框一律 type=text（不自行扩 password 契约；DXT/MCPB 包那边才有
//     BundleConfigField.sensitive）
//   - schema.required 为字段名数组；缺填禁用提交
//   - x-from 只影响主进程注入位置（header/query），前端不渲染差异
//
// 交互照抄 UploadSkillDialog 的锁定模式：提交期间禁用全部可交互元素（Esc /
// 遮罩关闭同样锁死）；失败红字留在弹窗可重试；成功后弹窗自关。
import { useState, type FormEvent } from 'react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import type { JsonSchemaLike } from '../../ipc/types';

/** placeholder=description 截断上限（过长描述撑爆输入框反而难读） */
const PLACEHOLDER_MAX = 64;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 提交锁定期传给 Dialog 的关闭回调（Esc / 遮罩点击 no-op，对齐 UploadSkillDialog） */
const noop = (): void => undefined;

interface Props {
  /** 服务器显示名（弹窗标题「连接 {serverName}」） */
  serverName: string;
  /** install 返回的 configSchema——properties 键即配置字段名 */
  schema: JsonSchemaLike;
  /** 提交（View 层接线 installSmitheryRemote；reject 时红字留在弹窗） */
  onSubmit: (config: Record<string, string>) => Promise<void>;
  onClose: () => void;
}

export function McpConnectDialog({ serverName, schema, onSubmit, onClose }: Props) {
  const fields = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const missingRequired = fields.some(
    ([name]) => required.has(name) && !(values[name] ?? '').trim(),
  );
  const lockAll = submitting;
  const canSubmit = !missingRequired && !lockAll;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // 下发必填 + 非空可选项（空可选项不下发——避免空串进 header / query）
      const config: Record<string, string> = {};
      for (const [name] of fields) {
        const v = (values[name] ?? '').trim();
        if (v || required.has(name)) config[name] = v;
      }
      await onSubmit(config);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={lockAll ? noop : onClose} title={`连接 ${serverName}`} width={448}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
        {fields.map(([name, prop]) => (
          <Input
            key={name}
            label={prop.title ?? name}
            placeholder={prop.description ? truncate(prop.description, PLACEHOLDER_MAX) : undefined}
            type="text"
            value={values[name] ?? ''}
            disabled={lockAll}
            onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
          />
        ))}
        {error && <div className="text-status-error text-sm break-all">{error}</div>}
        <div className="flex gap-2 justify-end mt-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={lockAll}>
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? '连接中…' : '连接'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
