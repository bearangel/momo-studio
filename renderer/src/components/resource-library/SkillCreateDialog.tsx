// renderer/src/components/resource-library/SkillCreateDialog.tsx
//
// 新建 SKILL.md 表单弹窗（spec §4.3）：
//   - 三段表单：名称 / 描述 / Markdown 正文
//   - 实时预览生成的 SKILL.md（frontmatter + 正文）
//   - slug 与已装 skill 重名时给覆盖警示（mount 时取一次已装列表做预检）
//   - 提交走 resource:createSkill；成功提示保留展示（对齐 UploadSkillDialog 模式）
//
// 命名约定：
//   - 权威 slug 由主进程 nameToSlug 生成——renderer 只算本地 previewSlug 用于
//     覆盖预检/显示，不参与提交载荷（防止两端规则漂移产生空发/漏覆盖）。
//   - 关闭按钮锁定策略：创建中时关闭按钮 disabled（锁定对外交互）；Dialog 的
//     onClose 始终透传 onClose 给父级，弹窗本身不带锁（与 UploadSkillDialog 一致）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

interface Props {
  onClose: () => void;
  /** 创建成功后调用（父组件据此刷新已安装 skill 列表） */
  onSuccess: () => void;
}

export function SkillCreateDialog({ onClose, onSuccess }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 已装 skill slug 集（仅 mount 取一次；权威 slug 在主进程）
  const [existingSlugs, setExistingSlugs] = useState<Set<string>>(new Set());

  // 挂载即取已装 skill slug 集（覆盖警示预检；失败不阻断创建）
  useEffect(() => {
    let cancelled = false;
    ipc.resource
      .list({ type: 'skill' })
      .then((items) => {
        if (!cancelled) setExistingSlugs(new Set(items.map((i) => i.slug)));
      })
      .catch(() => {
        // 预检失败静默——不影响创建主路径
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 本地同款 slug 化（仅预览/预检用；权威 slug 由主进程生成）
  const previewSlug = useMemo(
    () =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, ''),
    [name],
  );
  const willOverwrite = previewSlug !== '' && existingSlugs.has(previewSlug);
  const canCreate =
    name.trim() !== '' && description.trim() !== '' && body.trim() !== '' && !creating;

  // 预览内容（与写入 YAML 完全一致——YAML 字符串转义走 JSON.stringify 保证正确转义）
  const preview = `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n${body}`;

  const handleCreate = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const uploaded = await ipc.resource.createSkill({
        name: name.trim(),
        description: description.trim(),
        body,
      });
      setSuccessMsg(`已创建：${uploaded.slug}（${uploaded.description}）`);
      // 先触发父组件刷新，再保留展示成功消息（对齐 UploadSkillDialog 模式）
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="新建 SKILL.md" width={520}>
      <div className="flex flex-col gap-3">
        <Input
          label="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：pdf-report-writer"
          autoFocus
        />
        <Input
          label="描述"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明用途（注入索引用）"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="skill-body" className="text-sm text-secondary">
            正文（Markdown）
          </label>
          <textarea
            id="skill-body"
            aria-label="正文"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'# 使用指引\n…'}
            className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none resize-y"
          />
        </div>
        {willOverwrite && (
          <div className="text-xs text-status-warning">
            已存在同名 skill（{previewSlug}），保存将覆盖
          </div>
        )}
        <details className="border border-subtle rounded-md px-3 py-2">
          <summary className="text-sm text-secondary cursor-pointer select-none">
            预览生成的 SKILL.md
          </summary>
          <pre className="mt-2 text-xs font-mono text-secondary whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
            {preview}
          </pre>
        </details>
        {successMsg && <div className="text-status-success text-sm break-all">{successMsg}</div>}
        {error && <div className="text-status-error text-sm break-all">{error}</div>}
        <div className="flex gap-2 justify-end mt-1">
          <Button variant="ghost" type="button" onClick={onClose} disabled={creating}>
            关闭
          </Button>
          <Button type="button" disabled={!canCreate} onClick={() => void handleCreate()}>
            {creating ? '创建中…' : '创建'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}