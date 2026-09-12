// electron/tests/journal/detector.win32.test.ts
//
// scanUnjournaled 路径归一（v2.10 T2 :144 段）的 win32 语义测试。
// 模板来源：tests/platform/paths.win32.test.ts 文件头。
//
// 可测面论证（brief：纯比对段抽测或经 parsePorcelain 后路径归一断言——以
// 可测面为准）：scanUnjournaled 的路径面 = porcelain 相对路径 → resolve 到
// 仓根 → relative 回 workspace 根 → POSIX '/' 归一 → 与账本 path（Windows
// 反斜杠形态，store 侧既有 \\ → / 归一）对账。本文件锁整链输出形态。
//
// mock 策略：
//   - node:path → win32（模板）
//   - ../git/repos → 可变仓清单（vi.hoisted holder）——真实 discoverRepos 走
//     Linux fs，win32 形态目录不存在恒空；对账对象是「解析 + 归一」逻辑，
//     不是目录扫描（后者由 detector.test.ts 真实 git fixture 覆盖）
//   - store 用最小只读 fake（listByWorkspace / listByTask 是 scanUnjournaled
//     的全部消费面，路径归一测试不涉及 hash / blob / 插入语义）；真实 DB
//     fixture 在 win32 path mock 下不可用——storage 层 userData 目录拼接会被
//     win32 join 打穿。真实 store 语义由 detector.test.ts 既有用例覆盖
//   - GitRunner 注入 fake porcelain（真实 git 在 Linux 容器产出 posix 相对
//     路径，无法复现 Windows 归一链——与 detector.test.ts 同一注入位）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { scanUnjournaled } from '../../src/main/journal/detector';
import type { GitRunner } from '../../src/main/journal/detector';
import { __setJournalStoreForTest } from '../../src/main/journal/recorder';
import type { JournalStore } from '../../src/main/journal/store';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

const { mockRepos } = vi.hoisted(() => ({
  mockRepos: { list: ['C:\\WS'] as string[] },
}));

vi.mock('../../src/main/git/repos', () => ({
  discoverRepos: () => mockRepos.list,
}));

const fakeStore = {
  listByWorkspace: () => [{ path: 'a\\b.txt' }],
  listByTask: () => [],
} as unknown as JournalStore;

function okRunner(stdout: string): GitRunner {
  return async () => ({ code: 0, stdout, stderr: '', errCode: null, truncated: false });
}

afterEach(() => {
  __setJournalStoreForTest(null);
  mockRepos.list = ['C:\\WS'];
});

describe('scanUnjournaled（win32 语义）', () => {
  it('porcelain 路径经 resolve/relative 链统一 POSIX 分隔符：与反斜杠账本条目对账命中', async () => {
    __setJournalStoreForTest(fakeStore);
    const res = await scanUnjournaled('ws-A', 'C:\\WS', null, {
      // git porcelain 恒输出 '/' 分隔相对路径（含 Windows）；resolve 归一为
      // 反斜杠绝对路径后必须再归一回 POSIX 才能与账本集对账
      runner: okRunner('?? a/b.txt\n?? Services/d/e.py\n'),
    });
    expect(res.degraded).toBe(false);
    expect(res.repos).toEqual(['C:\\WS']);
    expect(res.journaled).toEqual(['a/b.txt']);
    expect(res.unjournaled).toEqual(['Services/d/e.py']);
  });

  it('发现列表盘符大小写变体仓根（c:\\WS）同样归一对齐', async () => {
    mockRepos.list = ['c:\\WS'];
    __setJournalStoreForTest(fakeStore);
    const res = await scanUnjournaled('ws-A', 'C:\\WS', null, {
      runner: okRunner('?? a/b.txt\n'),
    });
    expect(res.degraded).toBe(false);
    expect(res.journaled).toEqual(['a/b.txt']);
    expect(res.unjournaled).toEqual([]);
  });

  it('taskId 指定走 listByTask 基线（空基线 → 全部未入账）', async () => {
    __setJournalStoreForTest(fakeStore);
    const res = await scanUnjournaled('ws-A', 'C:\\WS', 'T-1', {
      runner: okRunner('?? a/b.txt\n'),
    });
    expect(res.journaled).toEqual([]);
    expect(res.unjournaled).toEqual(['a/b.txt']);
  });
});
