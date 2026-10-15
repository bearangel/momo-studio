// electron/tests/plugin/manifest.test.ts
//
// manifest 校验管线（spec §2.4 步骤 1-4）纯函数锁：形状 / 白名单 / 路径安全 / 存在性。
// 纯函数无 DB——目录用真实 tmpdir（validateManifest 走 fs.existsSync）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseManifest,
  validateManifest,
  PluginManifestError,
} from '../../src/main/plugin/manifest';

function mkRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pkg-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const BASE = {
  id: 'codegraph',
  name: 'Codegraph',
  version: '0.1.0',
  description: '代码图谱',
  components: { tools: './tools' },
};

describe('parseManifest', () => {
  it('坏 JSON 抛中文错', () => {
    expect(() => parseManifest('{oops')).toThrow(/manifest 不是合法 JSON/);
  });

  it('缺必填字段抛错并列出字段', () => {
    expect(() => parseManifest(JSON.stringify({ id: 'x' }))).toThrow(/name/);
  });
});

describe('validateManifest', () => {
  it('合法 manifest 通过', () => {
    const root = mkRoot({ 'tools/cg.js': 'module.exports = {};' });
    expect(() => validateManifest(parseManifest(JSON.stringify(BASE)), root)).not.toThrow();
  });

  it('id 不在白名单抛 PluginManifestError 且 issue 带字段路径', () => {
    const root = mkRoot({ 'tools/cg.js': '' });
    const bad = { ...BASE, id: 'Bad Id!' };
    try {
      validateManifest(parseManifest(JSON.stringify(bad)), root);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginManifestError);
      expect((err as PluginManifestError).issues[0].field).toBe('id');
    }
  });

  it('components 路径越界（../ 与绝对路径与反斜杠）逐一拒绝', () => {
    const root = mkRoot({ 'tools/cg.js': '' });
    for (const evil of ['../escape', '/etc/passwd', '.\\evil']) {
      const bad = { ...BASE, components: { tools: evil } };
      const issues = (() => {
        try {
          validateManifest(parseManifest(JSON.stringify(bad)), root);
          return [];
        } catch (err) {
          return err instanceof PluginManifestError ? err.issues : [];
        }
      })();
      expect(issues.some((i) => i.field.startsWith('components.tools'))).toBe(true);
    }
  });

  it('声明的组件目录不存在拒绝', () => {
    const root = mkRoot({});
    expect(() => validateManifest(parseManifest(JSON.stringify(BASE)), root)).toThrow(
      /components\.tools/,
    );
  });

  it('version 不在白名单拒绝', () => {
    const root = mkRoot({ 'tools/cg.js': '' });
    expect(() =>
      validateManifest(parseManifest(JSON.stringify({ ...BASE, version: 'a b' })), root),
    ).toThrow(PluginManifestError);
  });

  it('多个违规聚合在同一次 PluginManifestError 里', () => {
    const root = mkRoot({});
    const bad = { ...BASE, id: 'X!', version: 'a b' };
    try {
      validateManifest(parseManifest(JSON.stringify(bad)), root);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginManifestError);
      expect((err as PluginManifestError).issues).toHaveLength(3); // id + version + tools 不存在
    }
  });
});
