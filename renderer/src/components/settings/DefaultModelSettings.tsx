// renderer/src/components/settings/DefaultModelSettings.tsx
//
// 默认模型设置占位（P2 Task 4）。T7 阶段会实现「按用途选择默认模型」逻辑。
// 当前任务只确保菜单点击 → 占位渲染 → 设置页骨架完整。
export function DefaultModelSettings() {
  return (
    <div className="space-y-4">
      <h2 className="text-neutral-100 text-base">默认模型</h2>
      <p className="text-sm text-neutral-400">默认模型设置——T7 实现</p>
      <p className="text-xs text-neutral-500 leading-relaxed">
        计划提供按用途选择默认模型：会话模型（agent 未配置时使用）、任务标题生成等系统用途。
      </p>
    </div>
  );
}