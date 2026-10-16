// electron/src/main/plugin/event-sources.ts
//
// 15 事件源接线（spec §5.1）：storage 层信号经模块级 setter 注入 emit 回调
// （防 storage → HookBus 反向依赖，setBridgeRouter 先例）；emit 一律
// fire-and-forget——事务包裹处（insertSessionWithMembers 等）由 repo 层
// 分发点保证在事务外或同步即刻返回（HookBus.dispatch 本身微任务化，Review
// Focus #5）。resource/workspace 事件在 IPC handler 成功后分发。
import { logger } from '../logger';
import type { HookBus, PluginHookEvent } from './hook-bus';

type Emit = (event: PluginHookEvent, payload: unknown) => void;

let emit: Emit = () => undefined;

/** wire：注入 bus dispatch + 各信号点（app 启动序列调用一次；测试可重复调） */
export function wirePluginEventSources(bus: HookBus, customEmit?: Emit): void {
  emit = customEmit ?? ((event, payload) => bus.dispatch(event, payload));
}

/** repo 层调用（sessions/repo.ts 内嵌一行 emitPluginEvent(...)） */
export function emitPluginEvent(event: PluginHookEvent, payload: unknown): void {
  try {
    emit(event, payload);
  } catch (err) {
    logger.warn('插件事件分发失败（降级）', {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
