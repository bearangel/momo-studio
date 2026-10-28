// electron/tests/hub/accounting.test.ts
//
// hub 记账面分层锁（M2.4 T5）：loadHubAccountingSet 从 mirror-applier 抽到
// accounting.ts（纯搬移，函数体逐行相同）。分层目标是切断「查询单点」对镜像
// 应用器的反向依赖——builder 只用记账查询，不应被拖入自愈链/目录缓存/网络链。
//
// 机械锁（源码静态断言，两条）：
//   1. snapshot-builder.ts 不含 `from './mirror-applier'`
//   2. accounting.ts 不含 `from './mirror-applier'`（防搬错成环：自愈链不得回流）
//
// 行为基线由 publish-accounting / mirror-applier / snapshot-builder 三套用例承担
// （本文件只管依赖方向，不重复断言语义）。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HUB_SRC = path.resolve(__dirname, '../../src/main/hub');
const FORBIDDEN_EDGE = "from './mirror-applier'";

function readHubSource(file: string): string {
  return fs.readFileSync(path.join(HUB_SRC, file), 'utf-8');
}

describe('记账面分层锁（M2.4 T5）', () => {
  it('snapshot-builder.ts 不依赖 mirror-applier（记账查询走 accounting 单点）', () => {
    expect(readHubSource('snapshot-builder.ts')).not.toContain(FORBIDDEN_EDGE);
  });

  it('accounting.ts 不依赖 mirror-applier（纯查询模块不得回流自愈链）', () => {
    expect(readHubSource('accounting.ts')).not.toContain(FORBIDDEN_EDGE);
  });
});
