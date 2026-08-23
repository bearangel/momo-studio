// renderer/src/components/settings/About.tsx
//
// 关于页占位（P2 Task 4）。T7 阶段会填充版本号、构建时间、第三方许可证等。
// 当前任务只确保菜单点击 → 占位渲染 → 设置页骨架完整。
export function About() {
  return (
    <div className="space-y-4">
      <h2 className="text-neutral-100 text-base">关于</h2>
      <p className="text-sm text-neutral-400">关于——T7 实现</p>
      <p className="text-xs text-neutral-500 leading-relaxed">
        计划展示应用名称、版本号、构建时间、关键依赖许可等信息。
      </p>
    </div>
  );
}