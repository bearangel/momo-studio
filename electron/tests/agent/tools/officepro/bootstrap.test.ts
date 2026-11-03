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

  // 终审 B1：fd 写白名单 + 只读 fd 语义 + callback 形态守卫
  it('Review Focus：writeSync 伪造 fd → 拒绝（fd 未授权写入）', async () => {
    const r = await run(`try { require('fs').writeSync(99, 'x'); console.log('SHOULD-NOT-PASS'); } catch (e) { console.log('GUARDED:' + e.message.slice(0, 12)); }`);
    expect(r.stdout).toContain('GUARDED:沙箱写守卫拒绝');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });

  it('守卫 open 拿到的可写 fd → writeSync 放行', async () => {
    const r = await run(`const fs=require('fs'); const fd=fs.openSync('fd-ok.txt','w'); fs.writeSync(fd,'hi'); fs.closeSync(fd); console.log('fd-write-ok', fs.readFileSync('fd-ok.txt','utf8'));`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('fd-write-ok hi');
  });

  it('只读 fd（open r）→ writeSync 由 OS 语义拒绝（EBADF/EACCES，不可借 r 打开写）', async () => {
    const r = await run(`const fs=require('fs'); fs.writeFileSync('readonly.txt','seed'); const fd=fs.openSync('readonly.txt','r'); try { fs.writeSync(fd,'x'); console.log('SHOULD-NOT-PASS'); } catch (e) { console.log('READONLY-BLOCKED:' + (e.code||e.message).slice(0,10)); }`);
    expect(r.stdout).toContain('READONLY-BLOCKED');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });

  it('callback 形态 fs.writeFile 越界 → 拒绝', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-cb-evil.txt');
    // 守卫在参数校验期同步抛（Node 对非法参数同步抛的惯例）——try/catch 覆盖
    const r = await run(`try { await new Promise((res, rej) => require('fs').writeFile(${JSON.stringify(outside)}, 'x', (e) => (e ? rej(e) : res()))); console.log('SHOULD-NOT-PASS'); } catch (e) { console.log('GUARDED:' + e.message.slice(0, 12)); }`);
    expect(r.stdout).toContain('GUARDED:沙箱写守卫拒绝');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });

  it('promises.open 写 flag 越界 → 拒绝', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-open-evil.txt');
    const r = await run(`try { await require('fs').promises.open(${JSON.stringify(outside)}, 'w'); console.log('SHOULD-NOT-PASS'); } catch (e) { console.log('GUARDED:' + e.message.slice(0, 12)); }`);
    expect(r.stdout).toContain('GUARDED:沙箱写守卫拒绝');
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

  // —— fd 族（openSync / promises.open）：写意图 flags 守卫，只读放行 ——

  it('fd 族：openSync 写意图 flags 越界 → 守卫拒绝（含 {flags} 对象形态）', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-evil-open.txt');
    const r = await run(
      `const fs = require('fs');
       try { fs.openSync(${JSON.stringify(outside)}, 'w'); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }
       try { fs.openSync(${JSON.stringify(outside)}, { flags: 'w' }); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }`,
    );
    expect((r.stdout.match(/GUARDED:沙箱写守卫拒绝/g) ?? []).length).toBe(2);
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });

  it('fd 族：openSync 沙箱内写放行；只读 flags 不触发守卫（ENOENT 而非守卫错误）', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-boot-missing-r.txt');
    const r = await run(
      `const fs = require('fs');
       const fd = fs.openSync('fd-ok.txt', 'w');
       fs.writeSync(fd, 'fd-data');
       fs.closeSync(fd);
       try { fs.openSync(${JSON.stringify(outside)}, 'r'); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('READ-PASSED:' + e.code); }
       console.log('fd-ok');`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('fd-ok');
    expect(r.stdout).toContain('READ-PASSED:ENOENT');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
    expect(r.stdout).not.toContain('沙箱写守卫拒绝');
    expect(fs.readFileSync(path.join(ws, 'fd-ok.txt'), 'utf-8')).toBe('fd-data');
  });

  it('fd 族：promises.open 写意图越界 → 守卫拒绝；沙箱内放行', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-evil-popen.txt');
    const r = await run(
      `const fsp = require('fs').promises;
       try { await fsp.open(${JSON.stringify(outside)}, 'w'); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }
       const fh = await fsp.open('pfd-ok.txt', 'w');
       await fh.writeFile('pfd-data');
       await fh.close();
       console.log('pfd-ok');`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('GUARDED:沙箱写守卫拒绝');
    expect(r.stdout).toContain('pfd-ok');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
    expect(fs.readFileSync(path.join(ws, 'pfd-ok.txt'), 'utf-8')).toBe('pfd-data');
  });

  // —— 流族（createWriteStream）：字符串形态 + {path} 对象形态 ——

  it('流族：createWriteStream 越界 → 守卫拒绝（字符串 + {path} 对象形态）', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-evil-stream.txt');
    const r = await run(
      `const fs = require('fs');
       try { fs.createWriteStream(${JSON.stringify(outside)}); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }
       try { fs.createWriteStream({ path: ${JSON.stringify(outside)} }); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }`,
    );
    expect((r.stdout.match(/GUARDED:沙箱写守卫拒绝/g) ?? []).length).toBe(2);
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });

  it('流族：createWriteStream 沙箱内 → 放行落盘', async () => {
    const r = await run(
      `const s = require('fs').createWriteStream('stream-ok.txt');
       s.end('stream-data');
       await new Promise((res) => s.on('finish', res));
       console.log('stream-ok');`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('stream-ok');
    expect(fs.readFileSync(path.join(ws, 'stream-ok.txt'), 'utf-8')).toBe('stream-data');
  });

  // —— 链接族（symlink/link，sync + promises）：只查落点，target 可指向外部 ——

  it('链接族：symlink/linkSync 落点越界 → 守卫拒绝；落点在沙箱内放行（target 可指向外部）', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-evil-link.txt');
    const outsideTarget = path.join(path.parse(tmp).root, 'momo-evil-target.txt');
    const r = await run(
      `const fs = require('fs');
       try { fs.symlinkSync('t', ${JSON.stringify(outside)}); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }
       try { fs.linkSync(${JSON.stringify(outsideTarget)}, ${JSON.stringify(outside)}); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }
       fs.symlinkSync(${JSON.stringify(outsideTarget)}, 'symlink-ok');
       fs.writeFileSync('link-src.txt', 'src');
       fs.linkSync('link-src.txt', 'hardlink-ok');
       console.log('link-ok');`,
    );
    expect(r.code).toBe(0);
    expect((r.stdout.match(/GUARDED:沙箱写守卫拒绝/g) ?? []).length).toBe(2);
    expect(r.stdout).toContain('link-ok');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
    expect(fs.lstatSync(path.join(ws, 'symlink-ok')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'hardlink-ok'), 'utf-8')).toBe('src');
  });

  it('链接族：promises.symlink/link 落点越界 → 守卫拒绝', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-evil-plink.txt');
    const r = await run(
      `const fsp = require('fs').promises;
       try { await fsp.symlink('t', ${JSON.stringify(outside)}); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }
       try { await fsp.link('src', ${JSON.stringify(outside)}); console.log('SHOULD-NOT-PASS'); }
       catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }
       console.log('plink-ok');`,
    );
    expect((r.stdout.match(/GUARDED:沙箱写守卫拒绝/g) ?? []).length).toBe(2);
    expect(r.stdout).toContain('plink-ok');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });
});
