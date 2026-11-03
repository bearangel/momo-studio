// electron/tests/agent/tools/officepro/manifest.test.ts
// 插件 manifest 与预置 agent 校验锁（spec 2026-11-03 §5.1/§5.4）。
import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { parseManifest, validateManifest } from '../../../../src/main/plugin/manifest';
import { PLUGIN_ROOT } from './fixtures';

describe('office-pro 插件 manifest 与预置 agent', () => {
  it('manifest 通过 validateManifest（含交叉引用：run_js ↔ tools/run_js.js、office-authoring ↔ skills 子目录）', () => {
    const manifest = parseManifest(fs.readFileSync(path.join(PLUGIN_ROOT, 'manifest.json'), 'utf-8'));
    expect(() => validateManifest(manifest, PLUGIN_ROOT)).not.toThrow();
  });

  it('agent YAML：defaultTools 含 plugin:office-pro/run_js 与 office 读取三件；不含 bash', () => {
    const raw = yamlLoad(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/office-pro.yaml'), 'utf-8')) as {
      spec?: { defaultTools?: Array<{ ref?: string }>; defaultSkills?: Array<{ ref?: string }> };
    };
    const refs = (raw.spec?.defaultTools ?? []).map((t) => t.ref ?? '');
    expect(refs).toContain('plugin:office-pro/run_js');
    expect(refs).toContain('office_read');
    expect(refs).toContain('office_read_cells');
    expect(refs).toContain('office_copy');
    expect(refs).not.toContain('bash');
    expect(raw.spec?.defaultSkills?.map((s) => s.ref)).toEqual(['office-authoring']);
  });
});
