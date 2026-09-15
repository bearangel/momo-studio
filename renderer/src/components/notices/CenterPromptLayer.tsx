// renderer/src/components/notices/CenterPromptLayer.tsx
//
// Tier A 阻断性确认层（spec 2026-09-15 §4.2）：安全区几何居中渲染阻断类提示卡
// （信任授权 / 释放等待）。层 pointer-events-none 不挡其余 UI；子卡 pointer-events-auto。
// 遮罩由需要强注意力的卡自带（信任卡），而非层统一——释放卡不剥夺用户输入。
//
// ⚠️ 几何实现约束（回归锁见本目录测试）：锚点与层均不得带 transform——transform
// 祖先会成为 position:fixed 后代的 containing block，信任卡遮罩（fixed inset-0，
// class 逐字复制 ui/Dialog.tsx）会被困在锚点盒内而非盖满视口。故锚点是 0×0 定位点
// （left/top = 安全区中点），居中位移由各卡自带 -translate-x/y-1/2（卡自身的
// transform 只影响其后代，不影响兄弟遮罩；同一惯用法即 Dialog 卡的 left-1/2 top-1/2
// -translate-x/y-1/2）。并发多卡（理论不同现，防御）同点居中、按渲染序叠放。
import type { ReactNode } from 'react';
import { useSafeArea } from '../../stores/browser-sidebar-rect.store';

export function CenterPromptLayer({ children }: { children?: ReactNode }) {
  const safe = useSafeArea();
  const cx = (safe.left + safe.right) / 2;
  const cy = (safe.top + safe.bottom) / 2;
  return (
    <div data-testid="center-prompt-layer" className="pointer-events-none fixed inset-0 z-50">
      {/* 定位锚点：0×0（子卡均为 absolute，锚点盒收缩为零尺寸——不产生点击死区） */}
      <div
        data-testid="center-prompt-anchor"
        className="pointer-events-auto absolute"
        style={{ left: `${cx}px`, top: `${cy}px` }}
      >
        {children}
      </div>
    </div>
  );
}
