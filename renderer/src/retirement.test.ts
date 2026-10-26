// renderer/src/retirement.test.ts
//
// M2.1 Task 5 退役回归锁：四个迁出组件（settings/GroupPanel、hub/DelegationPanel、
// hub/DelegationWizard、hub/ViewPanel）删除后，renderer/src 全量扫描断言零 import
// 引用 + 文件本体已删除——防后续改动把死入口偷偷接回（死链接回归即红）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RETIRED_MODULES = ['GroupPanel', 'DelegationPanel', 'DelegationWizard', 'ViewPanel'] as const;

/** 静态 import 与动态 import() 两种引用形态（相对路径/别名路径均命中） */
const IMPORT_RE = new RegExp(
  `from\\s+['"][^'"]*(?:${RETIRED_MODULES.join('|')})['"]` +
    `|import\\(\\s*['"][^'"]*(?:${RETIRED_MODULES.join('|')})['"]\\s*\\)`,
);

// vite 会转换 `new URL(字符串, import.meta.url)` 形态——这里走 fileURLToPath 手工取目录
const SRC_ROOT = `${fileURLToPath(import.meta.url).replace(/[^/]+$/, '')}`;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}${name}`;
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(`${full}/`));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('M2.1 Task 5 组件退役回归锁', () => {
  it('renderer/src 全量扫描：四个退役模块零 import 引用', () => {
    const offenders = collectSourceFiles(SRC_ROOT).filter((file) =>
      IMPORT_RE.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('四个退役模块文件本体已删除', () => {
    const retiredFiles = [
      'components/settings/GroupPanel.tsx',
      'components/settings/GroupPanel.test.tsx',
      'components/hub/DelegationPanel.tsx',
      'components/hub/DelegationPanel.test.tsx',
      'components/hub/DelegationWizard.tsx',
      'components/hub/ViewPanel.tsx',
      'components/hub/ViewPanel.test.tsx',
    ].map((rel) => `${SRC_ROOT}${rel}`);
    for (const file of retiredFiles) {
      expect(existsSync(file), `仍存在退役文件: ${file}`).toBe(false);
    }
  });
});
