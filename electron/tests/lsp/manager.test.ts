// electron/tests/lsp/manager.test.ts
// manager 泛化契约：per-language 键控 / binaries 顺序探测 / 并发上限 /
// run-state 实装 / tsserver 真实冒烟（skip-if-binary-missing，沿用
// 现有 lsp-tools.test 的真实 server 模式：30s 超时 + afterEach 强制清理）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureLspManager,
  getLspManager,
  getLspRunState,
  shutdownAllLspManagers,
  MAX_ACTIVE_SERVERS_PER_WS,
} from '../../src/main/lsp/manager';
import { REGISTRY, findBinaryInPath } from '../../src/main/lsp/registry';
// run-state 模块直连（detect.ts 消费的同一路径）——锁「实装而非桩」
import { getLspRunState as getRunStateFromModule } from '../../src/main/lsp/run-state';

const LSP_TEST_TIMEOUT = 30_000;
const hasTsLs = findBinaryInPath(['typescript-language-server']) !== null;

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lsp-mgr-')); });
afterEach(async () => { await shutdownAllLspManagers(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('键控与上限（不触真实 server——用必然失败的伪 spec 断言异常路径）', () => {
  it('getLspManager 未启动返回 undefined；启动失败（伪二进制）reject 且单例被驱逐不毒化', async () => {
    const ws = `ws-m1-${Date.now()}`;
    expect(getLspManager(ws, 'typescript')).toBeUndefined();
    const fake = { ...REGISTRY.find((s) => s.languageId === 'typescript')!, binaries: ['nonexistent-lsp-bin-xyz'] };
    await expect(ensureLspManager(ws, tmpDir, fake)).rejects.toThrow(/已关闭|spawn 失败|未安装/i);
    // 失败的 manager 不得留在单例表——下次调用重新尝试而非永远拿到死实例
    expect(getLspManager(ws, 'typescript')).toBeUndefined();
  });

  it(`并发第 ${MAX_ACTIVE_SERVERS_PER_WS + 1} 门启动报中文错误`, async () => {
    const ws = `ws-m2-${Date.now()}`;
    // 预占 3 个活跃槽（直接操作内部计数的测试钩子）
    for (let i = 0; i < MAX_ACTIVE_SERVERS_PER_WS; i++) {
      await import('../../src/main/lsp/manager').then((m) => m.__testOccupySlot(ws));
    }
    const spec = REGISTRY.find((s) => s.languageId === 'typescript')!;
    await expect(ensureLspManager(ws, tmpDir, spec)).rejects.toThrow(/活跃语言服务已达上限/);
  });

  it('getLspRunState 缺省 stopped', () => {
    expect(getLspRunState(`ws-m3-${Date.now()}`, 'go')).toBe('stopped');
  });
});

describe('run-state 实装（detect.ts 消费的模块路径不再恒 stopped）', () => {
  it('未启动 stopped；tsserver 运行中经 run-state 模块查得 running（区分旧桩）', async () => {
    const ws = `ws-m3b-${Date.now()}`;
    expect(getRunStateFromModule(ws, 'typescript')).toBe('stopped');
    if (!hasTsLs) return; // 宿主无 typescript-language-server 时只锁缺省态
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const file = path.join(tmpDir, 'a.ts');
    fs.writeFileSync(file, 'export const v = 1;\n');
    const spec = REGISTRY.find((s) => s.languageId === 'typescript')!;
    await ensureLspManager(ws, tmpDir, spec);
    expect(getRunStateFromModule(ws, 'typescript')).toBe('running');
  }, LSP_TEST_TIMEOUT);
});

describe('握手失败孤儿进程回收（2026-10-01 Task 3 评审遗留）', () => {
  it('initialize 握手失败（server 回 error）：SIGKILL 子进程 + 驱逐单例不毒化', async () => {
    const ws = `ws-m5-${Date.now()}`;
    // 伪 server：写 pid 文件后立即对 initialize 回 JSON-RPC error 并保持存活
    //（15s 自退兜底：防测试自身失败时泄漏进程）。进程被正确 SIGKILL 时
    // kill(pid, 0) 抛 ESRCH——未被 kill 则存活（孤儿）。
    const pidFile = path.join(tmpDir, 'fake-server.pid');
    const script = [
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `const b = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boot failed' } });`,
      `process.stdout.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b);`,
      `setTimeout(() => process.exit(0), 15000);`,
    ].join('\n');
    const spec = {
      ...REGISTRY.find((s) => s.languageId === 'typescript')!,
      binaries: [process.execPath],
      args: ['-e', script],
    };
    await expect(ensureLspManager(ws, tmpDir, spec)).rejects.toThrow(/LSP 错误|已关闭/);
    // 失败单例被驱逐（ensureLspManager 既有语义——回归锁一并覆盖）
    expect(getLspManager(ws, 'typescript')).toBeUndefined();
    // 孤儿进程已回收：pid 不再存活（kill 信号送达 + libuv 收尸有微小竞态窗口，重试）
    const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
    expect(Number.isFinite(pid)).toBe(true);
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    }, { timeout: 3000, interval: 50 });
  }, LSP_TEST_TIMEOUT);
});

describe.skipIf(!hasTsLs)('tsserver 真实冒烟（迁移后协议仍通）', () => {
  it('diagnostics 返回语法错误；references 含定义位', async () => {
    const ws = `ws-m4-${Date.now()}`;
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const file = path.join(tmpDir, 'a.ts');
    fs.writeFileSync(file, 'const x: number = "not-a-number";\nexport function fn(): number { return x; }\n');
    const spec = REGISTRY.find((s) => s.languageId === 'typescript')!;
    const mgr = await ensureLspManager(ws, tmpDir, spec);
    const diags = await mgr.getDiagnostics(file, fs.readFileSync(file, 'utf-8'));
    expect(diags.length).toBeGreaterThan(0); // 类型错误被捕获
    expect(getLspRunState(ws, 'typescript')).toBe('running');
    const refs = await mgr.findReferences(file, 1, 16); // fn 定义位（0-based line 1）
    expect(refs.length).toBeGreaterThanOrEqual(1);
  }, LSP_TEST_TIMEOUT);
});

describe('错误保真（2026-10-08：秒退二进制的 stderr 诊断透传）', () => {
  it('rustup shim 形态（打印错误即退）：拒绝消息含 exit code + stderr 原文 + 失败驱逐', async () => {
    const ws = `ws-m5-${Date.now()}`;
    // 伪二进制 = 本机事故复现：stderr 一行错误后 exit 1（PATH 注入）
    const fakeBin = path.join(tmpDir, 'fake-crash-ls');
    fs.writeFileSync(
      fakeBin,
      '#!/bin/sh\necho "error: Unknown binary \'fake-crash-ls\' in official toolchain" >&2\nexit 1\n',
    );
    fs.chmodSync(fakeBin, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
    try {
      const spec = {
        ...REGISTRY.find((s) => s.languageId === 'typescript')!,
        binaries: ['fake-crash-ls'],
        args: [],
      };
      await expect(ensureLspManager(ws, tmpDir, spec)).rejects.toThrow(
        /已关闭（进程退出 code=1 signal=null；stderr：[\s\S]*Unknown binary/s,
      );
      expect(getLspManager(ws, 'typescript')).toBeUndefined();
    } finally {
      process.env.PATH = oldPath;
    }
  }, LSP_TEST_TIMEOUT);
});
