// electron/src/main/plugin/bus-instance.ts
//
// HookBus 主进程单例（op-router 模块级惰性先例）：spawner 桥 / 事件源 /
// 生命周期接线共用同一实例。initPluginBus 在 app 启动序列（runMigrations 后）
// 调用；测试用 resetPluginBusForTest 换新实例。
import { HookBus } from './hook-bus';

let instance: HookBus | null = null;

export function initPluginBus(): HookBus {
  if (instance === null) instance = new HookBus();
  return instance;
}

export function getPluginBus(): HookBus {
  return initPluginBus();
}

export function resetPluginBusForTest(): HookBus {
  instance = new HookBus();
  return instance;
}
