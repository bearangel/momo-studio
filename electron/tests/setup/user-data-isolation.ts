// electron/tests/setup/user-data-isolation.ts
//
// 测试用户数据目录全局缺省隔离（R2，2026-11-04）：
// 生产代码经 resolveUserDataDir()（AP_USER_DATA_DIR ?? ~/.momo-studio）解析
// logs / state.db / skills / tmp / plugins 全部落点。多数测试文件已自行注入
// temp env，但未注入的文件会把 mock 告警写进真实 ~/.momo-studio/logs/main.log
// （实证：'inst1' / 'quota check failed' 假告警混入生产日志，误导过线上排查）。
//
// 治法（与 forks-ipc-guard 同层；vitest 模块隔离默认每测试文件重建 registry，
// setupFiles 随之每文件重跑）：
//   1. 顶层缺省注入：env 未设时指向本文件级 temp 目录——??= 不覆盖测试自设值
//   2. beforeEach 重断言：兜住「同文件先行用例 afterEach delete env」的洞
//      （paths.test.ts 先例）
// logger.ts 的 resolvePathFn 懒解析（每次写入才解析路径），env 生效即时。
import { beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const isolatedRoot = path.join(
  os.tmpdir(),
  `momo-vitest-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
);

process.env.AP_USER_DATA_DIR ??= isolatedRoot;

beforeEach(() => {
  process.env.AP_USER_DATA_DIR ??= isolatedRoot;
});
