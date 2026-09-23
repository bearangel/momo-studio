// renderer/src/components/resource-library/PresetLibraryDialog.tsx
// 预置库弹窗（P2.3 spec §5）：AddMenu「启用预置库」入口（仅 agent 页组装——
// Task 0 裁定：只有 agent 有 YAML→落库的启用管线）触发挂载，mount 拉
// resource:listBuiltinPresets(type)（Task 2 只读 IPC，本地 YAML 直读零网络）。
// 选中 → onSelect(slug) + 自关；View 侧复用 presetTarget/EnablePresetDialog
// 保留位完成「启用即配」。错误处理（spec §7）：读失败红字 + 重试；
// 空清单（mcp/skill 类型面）空态文案。
// Dialog 骨架照 UploadSkillDialog（ui/Dialog 原子件：Esc / 遮罩关闭）。
import { useCallback, useEffect, useState } from 'react';
import { PackageOpen } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BuiltinPresetItem, ResourceType } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';

interface Props {
  /** 预置类型（入口仅 agent 页组装，实际恒为当前 activeType） */
  type: ResourceType;
  /** 选中预置（slug 是启用链路 resource key——EnablePresetDialog 消费） */
  onSelect: (slug: string) => void;
  onClose: () => void;
}

export function PresetLibraryDialog({ type, onSelect, onClose }: Props) {
  // null = 加载中；resolve 后 [] = 空态
  const [presets, setPresets] = useState<BuiltinPresetItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPresets = useCallback(async (): Promise<void> => {
    setError(null);
    setPresets(null);
    try {
      setPresets(await ipc.resource.listBuiltinPresets(type));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [type]);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  // 选中：先通知父层（关预置库 + 打开 EnablePresetDialog），再自关（与父层关幂等）
  const handleSelect = (slug: string): void => {
    onSelect(slug);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} title="启用预置库" width={448}>
      {error !== null ? (
        <div className="flex flex-col items-start gap-2 py-3">
          <div role="alert" className="text-sm text-status-error break-all">
            预置清单读取失败：{error}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadPresets()}>
            重试
          </Button>
        </div>
      ) : presets === null ? (
        <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-tertiary">
          <Spinner />
          <span>加载中…</span>
        </div>
      ) : presets.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title="该类型暂无预置"
          description="预置目前仅提供内置 agent；MCP 与技能可从「＋」菜单本地导入"
        />
      ) : (
        <ul className="flex flex-col">
          {presets.map((preset) => (
            <li
              key={preset.slug}
              className="flex items-center gap-3 border-b border-subtle py-2 last:border-b-0"
            >
              {/* iconEmoji 是清单数据展示（agent 定义元数据），原样渲染文本而非 UI 图标 */}
              <span aria-hidden className="w-6 shrink-0 text-center text-base leading-none">
                {preset.iconEmoji}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-primary">{preset.name}</span>
                <span className="block truncate text-xs text-tertiary">{preset.description}</span>
              </span>
              <Button variant="secondary" size="sm" onClick={() => handleSelect(preset.slug)}>
                选择
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
