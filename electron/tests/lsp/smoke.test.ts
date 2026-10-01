// electron/tests/lsp/smoke.test.ts
// 多语言真实 server 冒烟（skip-if-binary-missing）：tsserver 系 / pyright / gopls
// 各一条 diagnostics 往返。冷启动慢——每用例 60s 超时。
// 环境自适应：server 二进制不在 PATH 的语言自动 skip（无二进制环境不挂红），
// 在 PATH 的语言真实起子进程往返（借 PATH 可用仓库内
// electron/node_modules/.bin 的 typescript-language-server）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureLspManager, shutdownAllLspManagers } from '../../src/main/lsp/manager';
import { REGISTRY, findBinaryInPath } from '../../src/main/lsp/registry';

// 收集期把仓库内 devDependencies 的 server 二进制注入 PATH（如
// typescript-language-server）——宿主未全局安装时真跑而非全量 skip。
// 每个测试文件独立 worker 进程，PATH 注入不外溢其他测试。
const repoBin = path.resolve(__dirname, '..', '..', 'node_modules', '.bin');
if (fs.existsSync(repoBin) && !(process.env.PATH ?? '').includes(repoBin)) {
  process.env.PATH = `${repoBin}${path.delimiter}${process.env.PATH ?? ''}`;
}

const SMOKE: Array<{ languageId: string; file: string; content: string }> = [
  {
    languageId: 'typescript',
    file: 'a.ts',
    content: 'const x: number = "bad";\n',
  },
  {
    languageId: 'python',
    file: 'a.py',
    content: 'def f() -> int:\n    return "bad"\n',
  },
  {
    // go 单独走 main.go + go.mod 布局（go.mod 本身无诊断，marker 建在 main.go）
    languageId: 'go',
    file: 'main.go',
    content: 'package main\n\nfunc main() { var x int = "bad"; _ = x }\n',
  },
];

beforeEach(async () => { await shutdownAllLspManagers(); });
afterEach(async () => { await shutdownAllLspManagers(); });

for (const caseItem of SMOKE) {
  const spec = REGISTRY.find((s) => s.languageId === caseItem.languageId)!;
  const hasBin = findBinaryInPath(spec.binaries) !== null;
  describe.skipIf(!hasBin)(`${caseItem.languageId} 真实冒烟`, () => {
    it('diagnostics 往返', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ap-lsp-smoke-${caseItem.languageId}-`));
      try {
        if (caseItem.languageId === 'go') {
          fs.writeFileSync(path.join(tmp, 'go.mod'), 'module smoke\n\ngo 1.21\n');
          fs.writeFileSync(path.join(tmp, 'main.go'), caseItem.content);
        } else {
          fs.writeFileSync(path.join(tmp, caseItem.file), caseItem.content);
          if (caseItem.languageId === 'typescript') {
            fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
          }
        }
        const target = path.join(tmp, caseItem.file);
        const mgr = await ensureLspManager(`smoke-${caseItem.languageId}`, tmp, spec);
        const diags = await mgr.getDiagnostics(target, fs.readFileSync(target, 'utf-8'));
        expect(diags.length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 60_000);
  });
}
