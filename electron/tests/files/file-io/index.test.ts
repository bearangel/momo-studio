// electron/tests/files/file-io/index.test.ts
//
// FileIo 主进程单例与默认通道同步（Task 6）：单例同一性、direct/proxy 通道
// 设定、teardown 复位。全用例零 DB——设置以 raw 注入（syncFileIoDefaults(raw?)）。
import { afterEach, describe, expect, it } from 'vitest';
import {
  __closeFileIoForTest,
  getFileIoService,
  syncFileIoDefaults,
} from '../../../src/main/files/file-io/index';
import { getDefaultContentIoForTest } from '../../../src/main/files/workspace-fs';
import { DirectContentIo, ProxyContentIo } from '../../../src/main/files/file-io/content-io';

afterEach(() => {
  __closeFileIoForTest();
});

describe('FileIo 单例与默认通道同步', () => {
  it('getFileIoService 返回同一实例', () => {
    expect(getFileIoService()).toBe(getFileIoService());
  });

  it('direct 设置 → 默认通道为 DirectContentIo', () => {
    syncFileIoDefaults({ mode: 'direct' });
    expect(getDefaultContentIoForTest()).toBeInstanceOf(DirectContentIo);
  });

  it('proxy 设置 → 默认通道为 ProxyContentIo（包住单例）', () => {
    syncFileIoDefaults({ mode: 'proxy' });
    expect(getDefaultContentIoForTest()).toBeInstanceOf(ProxyContentIo);
  });

  it('__closeFileIoForTest 清空单例与默认通道', () => {
    const first = getFileIoService();
    __closeFileIoForTest();
    expect(getFileIoService()).not.toBe(first);
  });
});
