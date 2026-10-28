// electron/tests/util/error-prefix-contract.test.ts
//
// A3 双侧契约：electron 侧产生的用户可见错误前缀（主进程文案）必须被 renderer
// 侧已知前缀集合覆盖，否则 TypePageShell 会再拼一层「加载失败：」形成双前缀。
//
// 跨 workspace 无共享 import（生产代码两侧各自常量，避免 electron/renderer 依赖
// 反向耦合）；本测试同时 import 两侧常量做包含关系断言——任一侧改字面量都会红。

import { describe, it, expect } from 'vitest';
import {
  ELECTRON_ERROR_PREFIXES,
  DOWNLOAD_RESOURCE_FAILURE_PREFIX,
} from '../../src/main/util/error-prefix';
import { KNOWN_ERROR_PREFIXES } from '../../../renderer/src/lib/error-prefix';

describe('错误文案前缀双侧契约（electron ⊆ renderer）', () => {
  it('electron 侧前缀集合非空', () => {
    expect(ELECTRON_ERROR_PREFIXES.length).toBeGreaterThan(0);
  });

  it('renderer 侧已知前缀集合非空', () => {
    expect(KNOWN_ERROR_PREFIXES.length).toBeGreaterThan(0);
  });

  it('electron 产生的每个前缀都在 renderer 已知集合中', () => {
    for (const prefix of ELECTRON_ERROR_PREFIXES) {
      expect(KNOWN_ERROR_PREFIXES as readonly string[]).toContain(prefix);
    }
  });

  it('下载资源包失败前缀两侧字面量一致', () => {
    expect(DOWNLOAD_RESOURCE_FAILURE_PREFIX).toBe('下载资源包失败：');
    expect(KNOWN_ERROR_PREFIXES as readonly string[]).toContain(DOWNLOAD_RESOURCE_FAILURE_PREFIX);
  });
});
