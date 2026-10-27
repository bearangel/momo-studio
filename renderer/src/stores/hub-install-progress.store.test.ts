// renderer/src/stores/hub-install-progress.store.test.ts
//
// P2-7 补装进度 store 契约：onInstallProgress 订阅 → 按 `${type}:${slug}` 键
// upsert 最新拍；done/failed 终态驻留 5s 后自动移除；同 key 新一轮事件取消
// 待清定时器（重装/重试不闪没）；disposer 退订 + 清定时器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetHubInstallProgressForTest,
  initHubInstallProgress,
  useHubInstallProgressStore,
} from './hub-install-progress.store';
import type { HubInstallProgressEvent } from '../ipc/types';

let progressCb: ((e: HubInstallProgressEvent) => void) | undefined;
let disposeSubscription: ReturnType<typeof vi.fn>;

const api = {
  hub: {
    // 保真 mock：真实 preload 退订会摘回调（ipcRenderer.off）——no-op 退订会让
    // 「disposer 后事件不进 store」用例假红（momo-test-rules 铁律 1）
    onInstallProgress: vi.fn((cb: (e: HubInstallProgressEvent) => void) => {
      progressCb = cb;
      return () => {
        progressCb = undefined;
        disposeSubscription();
      };
    }),
  },
};

function emit(e: HubInstallProgressEvent): void {
  progressCb?.(e);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  progressCb = undefined;
  disposeSubscription = vi.fn();
  (globalThis as unknown as { window: { api: typeof api } }).window = { api };
  __resetHubInstallProgressForTest();
});

afterEach(() => {
  // 清残留定时器句柄（状态复位在 __reset 内做）
  vi.useRealTimers();
});

describe('hub-install-progress store：订阅与 upsert', () => {
  it('init → 订阅 onInstallProgress；downloading/extracting 拍同 key 只留最新', () => {
    const dispose = initHubInstallProgress();
    expect(api.hub.onInstallProgress).toHaveBeenCalledTimes(1);

    emit({ stage: 'downloading', type: 'plugin', slug: 'codegraph', receivedBytes: 0, totalBytes: null });
    emit({ stage: 'downloading', type: 'plugin', slug: 'codegraph', receivedBytes: 5_242_880, totalBytes: 58_720_256 });
    emit({ stage: 'extracting', type: 'plugin', slug: 'codegraph' });

    expect(useHubInstallProgressStore.getState().entries).toEqual({
      'plugin:codegraph': { stage: 'extracting', type: 'plugin', slug: 'codegraph' },
    });
    dispose();
  });

  it('不同 slug 并存互不干扰（镜像多资源补装形态）', () => {
    initHubInstallProgress();
    emit({ stage: 'downloading', type: 'skill', slug: 'superpowers-brainstorm' });
    emit({ stage: 'downloading', type: 'agent', slug: 'code-reviewer' });

    const entries = useHubInstallProgressStore.getState().entries;
    expect(Object.keys(entries).sort()).toEqual(['agent:code-reviewer', 'skill:superpowers-brainstorm']);
  });

  it('done 终态驻留 5s 后自动移除', () => {
    initHubInstallProgress();
    emit({ stage: 'downloading', type: 'skill', slug: 's1' });
    emit({ stage: 'done', type: 'skill', slug: 's1' });
    expect(useHubInstallProgressStore.getState().entries['skill:s1']?.stage).toBe('done');

    vi.advanceTimersByTime(5100);
    expect(useHubInstallProgressStore.getState().entries['skill:s1']).toBeUndefined();
  });

  it('failed 终态携带 message 驻留 5s 后移除', () => {
    initHubInstallProgress();
    emit({ stage: 'downloading', type: 'mcp', slug: 'm1' });
    emit({ stage: 'failed', type: 'mcp', slug: 'm1', message: '下载失败: HTTP 401（鉴权失败）' });
    expect(useHubInstallProgressStore.getState().entries['mcp:m1']).toMatchObject({
      stage: 'failed',
      message: expect.stringContaining('401'),
    });

    vi.advanceTimersByTime(5100);
    expect(useHubInstallProgressStore.getState().entries['mcp:m1']).toBeUndefined();
  });

  it('同 key 新一轮 downloading 取消待清定时器（终态后紧接重试不闪没）', () => {
    initHubInstallProgress();
    emit({ stage: 'done', type: 'plugin', slug: 'p1' });
    vi.advanceTimersByTime(4000); // 距终态 5s 驻留只差 1s
    emit({ stage: 'downloading', type: 'plugin', slug: 'p1' }); // 新一轮
    vi.advanceTimersByTime(2000); // 原定时器若未取消，此刻条目已被误清

    expect(useHubInstallProgressStore.getState().entries['plugin:p1']?.stage).toBe('downloading');
  });

  it('disposer → 退订 + 后续事件不进 store', () => {
    const dispose = initHubInstallProgress();
    emit({ stage: 'done', type: 'skill', slug: 's2' });
    dispose();
    expect(disposeSubscription).toHaveBeenCalledTimes(1);

    emit({ stage: 'downloading', type: 'skill', slug: 's3' });
    expect(useHubInstallProgressStore.getState().entries['skill:s3']).toBeUndefined();
    // 已驻留的终态条目随自身定时器正常清理（disposer 不强清展示中内容）
    vi.advanceTimersByTime(5100);
    expect(useHubInstallProgressStore.getState().entries['skill:s2']).toBeUndefined();
  });
});
