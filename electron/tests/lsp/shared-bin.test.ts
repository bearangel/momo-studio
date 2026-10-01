// 共享目录模块态 + PATH 探测链追加（D3 修正案）：
//   - setSharedBinDir / getSharedBinDir 模块态（默认 null 无副作用）
//   - findBinaryInPath 探测目录链追加 <sharedDir>/node_modules/.bin（非 null
//     且存在时）——app 注入的确定性状态，非宿主环境启发，伪 PATH 隔离模式
//     （显式 envPath）下同样生效：这正是 set/get 注入测试点
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setSharedBinDir, getSharedBinDir } from '../../src/main/lsp/shared-bin';
import { findBinaryInPath } from '../../src/main/lsp/registry';

let tmpShared: string | undefined;

afterEach(() => {
  // 清理：目录删除后 existsSync 门失效——残留模块态对后续用例惰性无害
  if (tmpShared) {
    fs.rmSync(tmpShared, { recursive: true, force: true });
    tmpShared = undefined;
  }
});

describe('shared-bin 模块态', () => {
  it('默认 null（registry/detect 保持 electron-free 可测）；set 后 get 返回注入值', () => {
    // 本文件独立模块实例（vitest 隔离）——首用例锁出厂缺省
    expect(getSharedBinDir()).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lsp-shared-state-'));
    tmpShared = dir;
    setSharedBinDir(dir);
    expect(getSharedBinDir()).toBe(dir);
  });
});

describe('findBinaryInPath 共享目录探测（set/get 注入）', () => {
  it('PATH 全 miss 时命中 <sharedDir>/node_modules/.bin 内可执行文件（隔离模式下同样生效）', () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lsp-shared-probe-'));
    tmpShared = shared;
    const nmBin = path.join(shared, 'node_modules', '.bin');
    fs.mkdirSync(nmBin, { recursive: true });
    const bin = path.join(nmBin, 'fake-shared-ls');
    fs.writeFileSync(bin, '#!/bin/sh\n', 'utf-8');
    fs.chmodSync(bin, 0o755);
    setSharedBinDir(shared);
    // 伪 PATH 隔离模式（显式 envPath）：共享目录是 app 注入态，必须仍被探测
    expect(findBinaryInPath(['fake-shared-ls'], '/nonexistent-dir-xyz')).toBe(bin);
  });

  it('目录不存在时跳过（未装过即无探测开销，不虚构结果）', () => {
    setSharedBinDir(path.join(os.tmpdir(), 'momo-lsp-shared-not-created-xyz'));
    expect(findBinaryInPath(['nope'], '/nonexistent-dir-xyz')).toBeNull();
  });

  it('共享目录命中优先级低于真实 PATH（PATH 目录命中时不查共享目录）', () => {
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lsp-shared-prio-path-'));
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lsp-shared-prio-shared-'));
    tmpShared = shared;
    const pathBin = path.join(pathDir, 'fake-prio-bin');
    fs.writeFileSync(pathBin, '#!/bin/sh\n', 'utf-8');
    fs.chmodSync(pathBin, 0o755);
    const nmBin = path.join(shared, 'node_modules', '.bin');
    fs.mkdirSync(nmBin, { recursive: true });
    const sharedBin = path.join(nmBin, 'fake-prio-bin');
    fs.writeFileSync(sharedBin, '#!/bin/sh\n', 'utf-8');
    fs.chmodSync(sharedBin, 0o755);
    setSharedBinDir(shared);
    expect(findBinaryInPath(['fake-prio-bin'], pathDir)).toBe(pathBin);
    fs.rmSync(pathDir, { recursive: true, force: true });
  });
});
