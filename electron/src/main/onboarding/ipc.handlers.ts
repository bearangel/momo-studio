// electron/src/main/onboarding/ipc.handlers.ts
//
// onboarding:* IPC handlers（spec 2026-10-10 §5）。generatePlan / applyPlan
// 分别在 plan-generator / plan-applier 就绪后注册（分任务接线）。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { readOnboardingStatus, markOnboardingDone } from './status';
import { generateOnboardingPlan } from './plan-generator';

export function registerOnboardingHandlers(): void {
  ipcMain.handle('onboarding:getStatus', () => ({ status: readOnboardingStatus() }));

  ipcMain.handle('onboarding:markDone', (_e, input: { skipped: boolean }) => {
    markOnboardingDone(input.skipped);
    return { ok: true } as const;
  });

  ipcMain.handle(
    'onboarding:generatePlan',
    (_e, input: { requirement: string; providerId: string; modelId: string }) =>
      generateOnboardingPlan(input),
  );

  logger.info('Onboarding IPC handlers 已注册');
}
