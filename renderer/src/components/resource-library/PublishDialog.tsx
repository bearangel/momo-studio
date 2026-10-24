// renderer/src/components/resource-library/PublishDialog.tsx
//
// 发布到 momo-hub 对话框（M1 Task 14）——形态对照已批预览
// .superpowers/sdd/2026-10-24-momo-hub-m1-resource-distribution/task-14-preview.html：
//   - 四态机：表单 →（提交 hub:publishResource）→ 进行（锁表单 + 双按钮禁用 +
//     spinner「正在上传 v{version}…」）→ 成功（绿勾 + slug/体积回执摘要）/ 失败
//     （红条人话错误 + 版本字段保留可改 + 重试原字段直提）
//   - 元数据表单字段 ↔ HubPublishMeta（T13 契约）：name/version/description/tags/
//     category 预填自本地定义、全部可改；readme/iconEmoji 不进表单（主进程回填）
//   - ref 口径对齐 T13 buildPublishPackage 入参：agent=定义 id（custom 资源 slug 即
//     def.id）/ skill=slug / mcp=注册名 / plugin=插件域 id——四者恰均为 item.slug
//     （plugin 取 plugin.id 防御资源 id 前缀），此处单点收敛
//   - Esc 语义：进行态显式拦截（Dialog 原子件 onClose 包一层——防半途撤销歧义，
//     预览 notes 交互要点 5）
//   - 版本白名单（数字/字母/点/加减号）客户端预校验：不合法禁用发布——
//     不把必败包发上路（主进程 assertManifestValid 同防线）
import { useState, type FormEvent } from 'react';
import { AlertTriangle, Check, RefreshCw, Upload } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useHubStore } from '../../stores/hub.store';
import type { HubConnectionState, HubPublishResult, ResourceItem } from '../../ipc/types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';

/** hub 分类候选（预览定值五项） */
const CATEGORY_OPTIONS = ['开发', '效率', '分析', '工具', '其他'] as const;

/** hub version 白名单（协议 isValidHubVersion 同款：数字/字母/点/加减号） */
const VERSION_RE = /^[A-Za-z0-9.+-]+$/;

/** hub 连接态徽章形态（M0 HubSettingsPanel CONN_META 同款：6px 圆点 + 12px medium） */
const STATUS_META: Record<HubConnectionState, { label: string; text: string; dot: string }> = {
  online: { label: '已连接', text: 'text-status-success', dot: 'bg-status-success' },
  connecting: { label: '连接中', text: 'text-status-warning', dot: 'bg-status-warning' },
  disconnected: { label: '未连接', text: 'text-tertiary', dot: 'bg-disabled' },
};

/** 四类型发布定位键（T13 buildPublishPackage 入参对齐——测试经 IPC 调用锁契约） */
export function hubPublishRef(item: ResourceItem): string {
  return item.type === 'plugin' ? (item.plugin?.id ?? item.slug) : item.slug;
}

/** 体积回执格式：≥1MB 一位小数 MB，否则整 KB */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type Phase = 'form' | 'publishing' | 'success' | 'error';

interface Props {
  item: ResourceItem;
  onClose: () => void;
}

export function PublishDialog({ item, onClose }: Props) {
  const hubStatus = useHubStore((s) => s.status);
  const [name, setName] = useState(item.name);
  const [version, setVersion] = useState(
    item.version ?? item.custom?.skillFrontmatter?.version ?? '1.0.0',
  );
  const [description, setDescription] = useState(item.description);
  const [tags, setTags] = useState('');
  const [category, setCategory] = useState<string>('其他');
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<HubPublishResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const valid = name.trim() !== '' && VERSION_RE.test(version.trim());
  const meta = hubStatus ? STATUS_META[hubStatus.state] : null;

  const submit = (e?: FormEvent): void => {
    if (e) e.preventDefault();
    if (phase === 'publishing' || !valid) return;
    setPhase('publishing');
    ipc.hub
      .publishResource({
        type: item.type,
        ref: hubPublishRef(item),
        meta: {
          name: name.trim(),
          version: version.trim(),
          description: description.trim(),
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t !== ''),
          category,
        },
      })
      .then((r) => {
        setResult(r);
        setPhase('success');
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setPhase('error');
      });
  };

  const locked = phase === 'publishing';

  return (
    <Dialog
      open
      onClose={() => {
        // 进行态拦截 Esc/点遮罩（预览 notes 交互要点 5——防半途撤销歧义）
        if (!locked) onClose();
      }}
      title="发布到 momo-hub"
      icon={<Upload size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-secondary" />}
      footer={
        phase === 'success' ? (
          <Button onClick={onClose}>关闭</Button>
        ) : phase === 'error' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            <Button disabled={!valid} onClick={() => submit()}>
              <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
              重试
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={locked} onClick={onClose}>
              取消
            </Button>
            <Button disabled={locked || !valid} onClick={() => submit()}>
              <Upload size={16} strokeWidth={1.75} aria-hidden />
              发布
            </Button>
          </>
        )
      }
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        {/* 目标 hub 状态行（快照未落地时整行不渲染——不显示半吊子状态） */}
        {hubStatus && meta && (
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-flex items-center gap-1.5 font-medium ${meta.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
              {meta.label}
            </span>
            {hubStatus.hubUrl && <span className="text-tertiary">{hubStatus.hubUrl}</span>}
          </div>
        )}

        {phase === 'error' ? (
          <>
            <div role="alert" className="flex items-start gap-2.5 rounded-md bg-status-error-tint px-3 py-2.5 text-status-error">
              <AlertTriangle size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
              <span className="text-[13px] font-medium">发布失败：{errorMessage}</span>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="publish-version" className="text-sm text-secondary">
                版本
              </label>
              <Input
                id="publish-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
              <span className="text-xs text-tertiary">重试前可在此直接改版本号</span>
            </div>
          </>
        ) : phase === 'success' && result ? (
          <div className="flex flex-col items-center gap-2 py-3.5 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-status-success-tint text-status-success">
              <Check size={20} strokeWidth={1.75} aria-hidden />
            </span>
            <div className="text-sm font-semibold text-primary">已发布 v{result.version}</div>
            <div className="text-xs text-tertiary">
              {result.slug} · {formatSize(result.sizeBytes)} · 组内节点已可在「hub」页签安装
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="publish-name" className="text-sm text-secondary">
                名称
              </label>
              <Input
                id="publish-name"
                value={name}
                disabled={locked}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="publish-version" className="text-sm text-secondary">
                  版本
                </label>
                <Input
                  id="publish-version"
                  value={version}
                  disabled={locked}
                  onChange={(e) => setVersion(e.target.value)}
                />
                <span className="text-xs text-tertiary">仅数字 / 字母 / 点 / 加减号（hub 白名单）</span>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="publish-category" className="text-sm text-secondary">
                  分类
                </label>
                <Select
                  id="publish-category"
                  value={category}
                  disabled={locked}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="publish-description" className="text-sm text-secondary">
                描述
              </label>
              <textarea
                id="publish-description"
                rows={2}
                value={description}
                disabled={locked}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary placeholder:text-disabled focus:border-focus focus:outline-none disabled:opacity-50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="publish-tags" className="text-sm text-secondary">
                标签
              </label>
              <Input
                id="publish-tags"
                value={tags}
                disabled={locked}
                onChange={(e) => setTags(e.target.value)}
              />
              <span className="text-xs text-tertiary">多个标签用英文逗号分隔</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-secondary">类型</span>
              <Badge tone="accent">{item.type}</Badge>
            </div>
            {phase === 'publishing' && (
              <div className="flex items-center gap-2.5 rounded-md border border-subtle bg-surface-2 px-3 py-2.5">
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium text-primary">正在上传 v{version}…</span>
                  <span className="mt-0.5 text-xs text-tertiary">
                    打包并传输到 {hubStatus?.hubUrl ?? 'momo-hub'}
                  </span>
                </span>
              </div>
            )}
          </>
        )}

        {phase !== 'success' && (
          <p className="text-xs leading-relaxed text-tertiary">
            发布后，组内所有节点可在资源库「hub」页签安装此资源。
          </p>
        )}
      </form>
    </Dialog>
  );
}
