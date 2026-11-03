// bootstrap 行为锁（spec 2026-11-03 §5.2）：vendor 白名单解析 / fs 写守卫 /
// 顶层 await / 异常退出码 / vendor 缺失自诊。直接 spawn 纯 node（测试环境
// ELECTRON_RUN_AS_NODE 为 no-op，协议不变）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT, makeFakeVendor } from './fixtures';

const BOOTSTRAP = path.join(PLUGIN_ROOT, 'bootstrap/run.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-boot-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const vendor = path.join(tmp, 'vendor');
makeFakeVendor(vendor);

interface RunResult { code: number; stdout: string; stderr: string }

function run(script: string, vendorRoot = vendor): Promise<RunResult> {
  const scriptPath = path.join(tmp, `s-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(scriptPath, script, 'utf-8');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BOOTSTRAP, ws, scriptPath, vendorRoot],
      { cwd: ws, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe('bootstrap 沙箱入口', () => {
  it('vendor 白名单解析：require(pptxgenjs) 命中 vendor 假包', async () => {
    const r = await run(`const p = require('pptxgenjs'); console.log(p.FAKE);`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pptxgenjs');
  });

  it('Review Focus：写 workspace/tmp 之外 → 守卫拒绝', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-evil-target.txt');
    const r = await run(
      `try { require('fs').writeFileSync(${JSON.stringify(outside)}, 'x'); console.log('SHOULD-NOT-PASS'); }` +
      ` catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }`,
    );
    expect(r.stdout).toContain('GUARDED:沙箱写守卫拒绝');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });

  it('写 workspace 内 → 放行', async () => {
    const r = await run(`require('fs').writeFileSync('ok.txt', 'hi'); console.log('written');`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('written');
    expect(fs.existsSync(path.join(ws, 'ok.txt'))).toBe(true);
  });

  it('顶层 await 可用', async () => {
    const r = await run(`await new Promise((r2) => setTimeout(r2, 30)); console.log('tla-ok');`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tla-ok');
  });

  it('未捕获异常 → 退出码 1 + stderr 透传', async () => {
    const r = await run(`throw new Error('boom-bootstrap');`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('boom-bootstrap');
  });

  it('Review Focus：vendor 缺失 → 报错指引 build.sh，退出码 3', async () => {
    const emptyVendor = path.join(tmp, 'vendor-empty');
    fs.mkdirSync(emptyVendor, { recursive: true });
    const scriptPath = path.join(tmp, 'noop.js');
    fs.writeFileSync(scriptPath, '');
    const r = await new Promise<RunResult>((resolve) => {
      execFile(process.execPath, [BOOTSTRAP, ws, scriptPath, emptyVendor], { cwd: ws }, (err, _o, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ code, stdout: '', stderr: String(stderr) });
      });
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('build.sh');
  });
});
