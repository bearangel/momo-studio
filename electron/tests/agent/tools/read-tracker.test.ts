// electron/tests/agent/tools/read-tracker.test.ts
// Read-before-Edit 读账本（2026-09-26 升级：会话维度持久化 + 内容指纹守门）。
// 真实 SQLite 锁契约：跨实例（模拟跨进程/重启）读取记录经 DB 生效；
// 指纹漂移（bash/外部改动）精准拦截；子 agent 读取不解锁编辑。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb } from '../../../src/main/storage/db';
import { ReadTracker } from '../../../src/main/agent/tools/shared/read-tracker';

const tmpRoot = path.join(os.tmpdir(), `momo-readtracker-${Date.now()}-${randomUUID()}`);
let fileA: string;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fileA = path.join(tmpRoot, 'a.ts');
  fs.writeFileSync(fileA, 'const x = 1;');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('ReadTracker — 会话持久化 + 指纹守门', () => {
  it('add 后 assertRead 通过；新实例（内存清空，模拟重启/新进程）仍通过——DB 兜底', () => {
    const t1 = new ReadTracker();
    t1.add('sess-1', fileA);
    expect(() => t1.assertRead('sess-1', undefined, fileA)).not.toThrow();
    const t2 = new ReadTracker();
    expect(() => t2.assertRead('sess-1', undefined, fileA)).not.toThrow();
  });

  it('未读取时抛错（含路径）', () => {
    const t = new ReadTracker();
    expect(() => t.assertRead('sess-2', undefined, fileA)).toThrowError(/文件未读取[\s\S]*a\.ts/);
  });

  it('读取隔离按 session：别的 session 不解锁', () => {
    const t = new ReadTracker();
    t.add('sess-a', fileA);
    expect(() => t.assertRead('sess-b', undefined, fileA)).toThrowError(/文件未读取/);
  });

  it('指纹漂移：读取后文件被修改（bash/外部）→ 拦截并提示重读', () => {
    const t = new ReadTracker();
    t.add('sess-3', fileA);
    fs.writeFileSync(fileA, 'const x = 2; // bash 改过');
    expect(() => t.assertRead('sess-3', undefined, fileA)).toThrowError(/在读取后被修改[\s\S]*重新调用 read_file/);
  });

  it('同内容重写不触发漂移（指纹等值放行）', () => {
    const t = new ReadTracker();
    t.add('sess-4', fileA);
    fs.writeFileSync(fileA, 'const x = 1;');
    expect(() => t.assertRead('sess-4', undefined, fileA)).not.toThrow();
  });

  it('文件在读取后被删除 → 抛漂移错误（而非放行）', () => {
    const t = new ReadTracker();
    t.add('sess-5', fileA);
    fs.rmSync(fileA);
    expect(() => t.assertRead('sess-5', undefined, fileA)).toThrowError(/在读取后被修改/);
  });

  it('子 agent 读取 no-op——不解锁父/主 agent 的编辑', () => {
    const t = new ReadTracker();
    t.add('sess-6', fileA, 'parent-ssn');
    expect(() => t.assertRead('sess-6', undefined, fileA)).toThrowError(/文件未读取/);
  });

  it('子 agent（parentStreamSessionId 非空）编辑永远抛错（fresh-session）', () => {
    const t = new ReadTracker();
    t.add('sess-7', fileA);
    expect(() => t.assertRead('sess-7', 'parent-ssn', fileA)).toThrowError(/文件未读取/);
  });

  it('clear 只清内存缓存——DB 持久层保留（新实例仍通过）', () => {
    const t = new ReadTracker();
    t.add('sess-8', fileA);
    t.clear('sess-8');
    const t2 = new ReadTracker();
    expect(() => t2.assertRead('sess-8', undefined, fileA)).not.toThrow();
  });

  it('写后重新 add 更新指纹：连续编辑不触发漂移', () => {
    const t = new ReadTracker();
    t.add('sess-9', fileA);
    fs.writeFileSync(fileA, 'const x = 100;');
    t.add('sess-9', fileA);
    expect(() => t.assertRead('sess-9', undefined, fileA)).not.toThrow();
  });
});

describe('ReadTracker — 内容直传路径（B 方案收口：消除二次磁盘读）', () => {
  it('add(content) 不读盘：文件已被删除仍成功记录，assertRead(current=同内容) 通过', () => {
    const t = new ReadTracker();
    t.add('sess-c1', fileA, undefined, 'const x = 1;');
    fs.rmSync(fileA);
    expect(() => t.assertRead('sess-c1', undefined, fileA, 'const x = 1;')).not.toThrow();
    expect(() => t.assertRead('sess-c1', undefined, fileA, 'const x = 2;')).toThrowError(/在读取后被修改/);
  });

  it('同源口径（proxy 加密形态）：指纹记「agent 视角内容」而非磁盘字节——磁盘不同不误判，通道内容一致即放行', () => {
    // 模拟 proxy 模式：磁盘密文形态，agent 经通道读到明文
    fs.writeFileSync(fileA, 'cipher-bytes-on-disk');
    const t = new ReadTracker();
    t.add('sess-c2', fileA, undefined, 'agent-plaintext-view');
    // current = 通道读到的当前内容（与记录同源）→ 放行
    expect(() => t.assertRead('sess-c2', undefined, fileA, 'agent-plaintext-view')).not.toThrow();
    // current = 通道内容已变（密文外改动）→ 漂移拦截
    expect(() => t.assertRead('sess-c2', undefined, fileA, 'agent-changed-view')).toThrowError(/在读取后被修改/);
  });

  it('省略 content 保持磁盘回读 fallback（既有语义不回归）', () => {
    const t = new ReadTracker();
    t.add('sess-c3', fileA);
    expect(() => t.assertRead('sess-c3', undefined, fileA)).not.toThrow();
    t.add('sess-c3', fileA, undefined, 'differs-from-disk');
    // add 直传改写指纹后，fallback（磁盘 hash）与记录不一致 → 漂移
    expect(() => t.assertRead('sess-c3', undefined, fileA)).toThrowError(/在读取后被修改/);
  });
});
