// renderer/src/components/resource-library/DanglingRefsCard.tsx
// P2.2 Task 7：MCP 悬空引用提示卡（spec §6.3）——agent 定义按名字引用 MCP
// （defaultMcps[].ref），查无对应注册名即悬空。卡片点名悬空引用 + 引用它的
// agent 名单，提示用户装回或改引用；只提示不自动修复（D7，agent 编辑器 P3）。
//
// mount 拉一次 ipc.resource.danglingMcpRefs：空数组 / 加载失败 → 不渲染
// （静默，spec §5.4 同语义；主进程扫描异常也降级空数组）。
// 卡片样式照 TypePageShell installNotice 横幅基调，warning 色档。
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { DanglingMcpRef } from '../../ipc/types';

export function DanglingRefsCard() {
  const [refs, setRefs] = useState<DanglingMcpRef[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    try {
      ipc.resource
        .danglingMcpRefs()
        .then((result) => {
          if (!cancelled) setRefs(result);
        })
        .catch(() => {
          if (!cancelled) setRefs(null);
        });
    } catch {
      // window.api 缺面等同步异常——卡片静默不显示（与 reject 同语义）
      setRefs(null);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (!refs || refs.length === 0) return null;

  return (
    <div data-testid="dangling-refs-card" className="mx-4 mt-3 flex flex-col gap-1.5 self-start">
      {refs.map((ref) => (
        <div
          key={ref.refName}
          className="px-3 py-2 rounded-md border border-subtle bg-status-warning-tint text-status-warning text-sm inline-flex items-start gap-1.5"
        >
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden className="shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <div>{ref.agents.map((a) => a.name).join('、')} 引用了未安装的 MCP：{ref.refName}</div>
            <div className="text-xs">去 Smithery 搜索安装（注册名需与引用名一致），或编辑 agent 引用</div>
          </div>
        </div>
      ))}
    </div>
  );
}
