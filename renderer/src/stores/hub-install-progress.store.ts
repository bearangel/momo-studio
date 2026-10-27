// renderer/src/stores/hub-install-progress.store.ts
//
// P2-7 补装进度状态（M2.2 T5）：订阅 hub:installProgress 推送，按
// `${type}:${slug}` 键持有每个资源最新一拍。downloading/extracting 进行中
// 恒在场；done/failed 终态驻留 5s（用户可见窗口）后自动移除——同 key 新一轮
// 事件先取消待清定时器（重试/重装不闪没）。消费面：HubInstallNotice
// （MainShell 挂载一次）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { HubInstallProgressEvent } from '../ipc/types';

/** 终态条目驻留时长（完成/失败的可见窗口） */
const TERMINAL_TTL_MS = 5000;

interface HubInstallProgressState {
  /** key = `${type}:${slug}` → 最新事件拍（进行中 + 驻留中的终态） */
  entries: Record<string, HubInstallProgressEvent>;
}

export const useHubInstallProgressStore = create<HubInstallProgressState>(() => ({
  entries: {},
}));

/** key 前置计算（`${type}:${slug}` 单点） */
function keyOf(e: HubInstallProgressEvent): string {
  return `${e.type}:${e.slug}`;
}

const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRemoval(key: string): void {
  removalTimers.set(
    key,
    setTimeout(() => {
      removalTimers.delete(key);
      useHubInstallProgressStore.setState((s) => {
        const next = { ...s.entries };
        delete next[key];
        return { entries: next };
      });
    }, TERMINAL_TTL_MS),
  );
}

function cancelRemoval(key: string): void {
  const t = removalTimers.get(key);
  if (t) {
    clearTimeout(t);
    removalTimers.delete(key);
  }
}

/** 订阅补装进度推送（HubInstallNotice 挂载时调用一次）。返回解订阅函数（只退订——
 *  终态驻留定时器自然到期，不强清展示中内容）。 */
export function initHubInstallProgress(): () => void {
  const dispose = ipc.hub.onInstallProgress((e) => {
    const key = keyOf(e);
    cancelRemoval(key);
    if (e.stage === 'done' || e.stage === 'failed') scheduleRemoval(key);
    useHubInstallProgressStore.setState((s) => ({ entries: { ...s.entries, [key]: e } }));
  });
  return dispose;
}

/** 测试复位：清状态与定时器句柄（不触发 setState 通知也无妨——状态直接归空） */
export function __resetHubInstallProgressForTest(): void {
  for (const t of removalTimers.values()) clearTimeout(t);
  removalTimers.clear();
  useHubInstallProgressStore.setState({ entries: {} });
}
