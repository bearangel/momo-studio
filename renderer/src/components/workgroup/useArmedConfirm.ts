// renderer/src/components/workgroup/useArmedConfirm.ts
//
// P2-10 两步确认公共臂态 hook（M2.2 T5）：path2 观察——臂态 3s 窗口内 UI 无
// 「需再点一次」明示，用户读差异摘要超 3s 后次击无响应被误判为失灵。
// hook 统一三语义：臂态布尔 + 剩余秒（每秒递减，供「再次点击确认… · Ns」
// 呈现）+ 到期/disarm 双回落。消费面：DelegatedTaskCard 取消确认 /
// GroupMonitor 退组确认（MirrorWizard 覆盖确认与 HubSettingsPanel 忘记确认
// 域外不迁——各自本地实现保持，见 task-5 报告抽象裁定）。
import { useCallback, useEffect, useState } from 'react';

/** 臂态窗口（既有 D6/组头范式同值——两处消费面 3s 共识，不另开口子） */
export const ARMED_WINDOW_MS = 3000;

export interface ArmedConfirm {
  armed: boolean;
  /** 臂态剩余整秒（arm 瞬间 = ceil(windowMs/1000)，每秒递减，回落归 0） */
  remainingSec: number;
  /** 首击进入臂态；臂态内再 arm 重置窗口（deadline 跟随最新一次） */
  arm: () => void;
  /** 手动回落（菜单关闭/动作完成路径） */
  disarm: () => void;
}

export function useArmedConfirm(windowMs: number = ARMED_WINDOW_MS): ArmedConfirm {
  const [armed, setArmed] = useState(false);
  const [remainingSec, setRemainingSec] = useState(0);
  // armSeq 驱动 effect 重启（臂态内重新 arm 重置 deadline——armed 布尔不变
  // 不触发 effect 依赖变化）
  const [armSeq, setArmSeq] = useState(0);

  useEffect(() => {
    if (!armed) return;
    const deadline = setTimeout(() => {
      setArmed(false);
      setRemainingSec(0);
    }, windowMs);
    const tick = setInterval(() => {
      // 递减到 0 为止：到期同拍（deadline 与 tick 同在 t=3000）不回抬 1
      setRemainingSec((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => {
      clearTimeout(deadline);
      clearInterval(tick);
    };
  }, [armed, armSeq, windowMs]);

  const arm = useCallback(() => {
    setArmed(true);
    setRemainingSec(Math.ceil(windowMs / 1000));
    setArmSeq((seq) => seq + 1);
  }, [windowMs]);

  const disarm = useCallback(() => {
    setArmed(false);
    setRemainingSec(0);
  }, []);

  return { armed, remainingSec, arm, disarm };
}
