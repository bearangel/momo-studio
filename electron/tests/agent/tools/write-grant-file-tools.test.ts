// electron/tests/agent/tools/write-grant-file-tools.test.ts
// 文件写工具硬门控端到端（spec hard-gate §7）：真实 WorkspaceFS + 真实 FileTools /
// ApplyPatchTools，等待与桥注入替身。覆盖 write_file 越界→covered→落盘、denied、
// mv 源越界、apply_patch 越界、授权后 read_file 放行。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTools } from '../../../src/main/agent/tools/file-tools';
import { ApplyPatchTools } from '../../../src/main/agent/tools/apply-patch-tools';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { formatWriteDeniedResult } from '../../../src/main/agent/tools/write-grant-wait';
import { __setWriteGrantToolForTest } from '../../../src/main/agent/tools/write-grant-tool';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const capturedSends: Array<Record<string, unknown>> = [];
const realSend = process.send;

let root: string;
let outside: string;
let wfs: WorkspaceFS;
let ctx: ToolContext;

beforeEach(() => {
  // macOS 宿主 /var→/private/var symlink 可移植性：fixture 统一 realpath 归一，
  // 与 setExtraRootDirs / normalizeGrantDirs 的 realpath 产物严格同串——勿「简化」删掉
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wgf-root-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wgf-outside-')));
  wfs = new WorkspaceFS(root);
  ctx = {
    wsFs: wfs,
    workspaceId: 'ws-f',
    workspaceDir: root,
    streamSessionId: 'ss-f',
    roomId: 'room-f',
  } as unknown as ToolContext;
  capturedSends.length = 0;
  Object.defineProperty(process, 'send', {
    value: (msg: unknown): boolean => {
      capturedSends.push(msg as Record<string, unknown>);
      return true;
    },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(process, 'send', { value: realSend, configurable: true });
  __setWriteGrantToolForTest(null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/** covered 替身：授权 = outside 根（三层合成的动态层等价物） */
function grantOutsideOnWait(): void {
  __setWriteGrantToolForTest({
    net: async () => ({ netOn: false, toolchainOn: false, extraDirs: [fs.realpathSync(outside)] }),
    wait: async () => ({ kind: 'covered' as const }),
  });
}

describe('write_file 硬门控（spec §7）', () => {
  it('越界 → 上报 → covered → extra 根生效 → 真实落盘成功', async () => {
    grantOutsideOnWait();
    const target = path.join(outside, 'out.txt');
    const r = await new FileTools().execute('write_file', { path: target, content: 'hi' }, ctx);
    expect(r).toBe(`文件已写入: ${target}`);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('hi');
    expect(capturedSends.some((m) => m.type === 'write-blocked-report')).toBe(true);
  });

  it('越界 → denied → 拒绝文案返回 + 不落盘', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const target = path.join(outside, 'denied.txt');
    const r = await new FileTools().execute('write_file', { path: target, content: 'x' }, ctx);
    expect(r).toBe(formatWriteDeniedResult([fs.realpathSync(outside)]));
    expect(fs.existsSync(target)).toBe(false);
  });

  it('授权后 read_file 放行（extra 根读开放——edit 链前提）', async () => {
    const src = path.join(outside, 'readable.txt');
    fs.writeFileSync(src, 'content-读取');
    grantOutsideOnWait();
    // 先经一次 write 触发 covered 刷新 extra 根
    await new FileTools().execute('write_file', { path: path.join(outside, 'trigger.txt'), content: 't' }, ctx);
    const r = await new FileTools().execute('read_file', { path: src }, ctx);
    expect(r).toContain('content-读取');
  });
});

describe('mkdir / mv / rm 硬门控', () => {
  it('mkdir 越界 denied → 拒绝文案 + 目录未建', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const target = path.join(outside, 'newdir');
    const r = await new FileTools().execute('mkdir', { path: target }, ctx);
    expect(r).toContain('用户已拒绝授权');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('mv 源在工作空间外 → covered 后移动成功（src 越界捕获）', async () => {
    grantOutsideOnWait();
    const src = path.join(outside, 'mv-me.txt');
    fs.writeFileSync(src, 'payload');
    const dst = path.join(root, 'moved.txt');
    const r = await new FileTools().execute('mv', { src, dst }, ctx);
    expect(r).toBe(`已移动: ${src} → ${dst}`);
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
  });
});

describe('apply_patch 硬门控', () => {
  it('patch 目标越界 → covered → 原子补丁落盘', async () => {
    grantOutsideOnWait();
    const target = path.join(outside, 'patched.txt');
    // V4A 方言对齐：本仓 parser 只认 *** Add/Update/Delete File 头，无 Begin/End 包装
    const patch = `*** Add File: ${target}\n+line1\n+line2\n`;
    const r = await new ApplyPatchTools().execute('apply_patch', { patch }, ctx);
    expect(r).toContain('已应用');
    expect(fs.readFileSync(target, 'utf-8')).toBe('line1\nline2\n');
  });

  it('patch 目标越界 → denied → 拒绝文案 + 未落盘', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    const target = path.join(outside, 'denied-patch.txt');
    const patch = `*** Add File: ${target}\n+x\n`;
    const r = await new ApplyPatchTools().execute('apply_patch', { patch }, ctx);
    expect(r).toContain('用户已拒绝授权');
    expect(fs.existsSync(target)).toBe(false);
  });
});
