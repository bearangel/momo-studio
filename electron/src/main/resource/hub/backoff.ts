// electron/src/main/resource/hub/backoff.ts
//
// hub API 失败退避负缓存——模式与 marketplace/client.ts 的 catalogFailureBackoff
// 一致（6a6c311 教训制度化）：失败后窗口内零网络重试，窗口过期自动恢复。
// 每个 hub provider 持有一个实例（key 仅供日志扩展，暂不参与逻辑）。

export interface Backoff {
  isBackedOff(): boolean;
  recordFailure(): void;
  recordSuccess(): void;
  __rewindForTest(ms: number): void;
}

export function createBackoff(key: string, windowMs = 60_000): Backoff {
  let until = 0;
  return {
    isBackedOff: () => until > Date.now(),
    recordFailure: () => {
      until = Date.now() + windowMs;
    },
    recordSuccess: () => {
      until = 0;
    },
    __rewindForTest: (ms) => {
      until -= ms;
    },
  };
}
