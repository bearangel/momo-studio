// electron/tests/plugin/manifest-crossref.test.ts
//
// manifest 校验步骤 5（spec §2.4）：components.agents 的 YAML 里 defaultTools
// 的 plugin: 前缀 ref 与 defaultSkills 引用，必须在本插件 tools 短名集与
// skills 子目录集内。YAML 坏 → issue。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest, validateManifest, PluginManifestError } from '../../src/main/plugin/manifest';

function mkRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-xref-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const BASE = (agentsYaml: string): Record<string, string> => ({
  'momo-plugin.json': JSON.stringify({
    id: 'cg',
    name: 'cg',
    version: '0.1.0',
    description: '',
    components: { tools: './tools', skills: './skills', agents: './agents' },
  }),
  'tools/explore.js': 'module.exports.createTools = () => ({});',
  'skills/usage/SKILL.md': '---\nname: usage\ndescription: d\n---\nbody',
  'agents/nav.yaml': agentsYaml,
});

const GOOD_YAML = `apiVersion: v1
kind: AgentDefinition
metadata:
  name: nav
  slug: nav
  version: 1.0.0
spec:
  declarative:
    systemPrompt: 你是导航员
    model:
      provider: openai
      model: gpt-4o
  defaultTools:
    - ref: plugin:cg/explore
  defaultSkills:
    - ref: usage
`;

const BAD_TOOL_YAML = GOOD_YAML.replace('plugin:cg/explore', 'plugin:cg/nonexistent');
const BAD_SKILL_YAML = GOOD_YAML.replace('- ref: usage', '- ref: nope');

function validateAt(root: string): PluginManifestError | null {
  try {
    validateManifest(
      parseManifest(fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8')),
      root,
    );
    return null;
  } catch (err) {
    return err instanceof PluginManifestError ? err : null;
  }
}

describe('validateManifest 步骤 5（交叉引用）', () => {
  it('合法引用（plugin: 前缀工具 + 本插件 skill）通过', () => {
    const root = mkRoot(BASE(GOOD_YAML));
    expect(validateAt(root)).toBeNull();
  });

  it('plugin: 工具 ref 不在本插件 tools 短名集 → issue（短名比对：YAML 写 plugin:cg/explore，tools defs 短名 explore——工具集取模块文件名不可静态知 defs，按约定 = 文件名去扩展）', () => {
    // tools/main.js 声明的短名集合 = ['main']（P2 约定：目录内模块文件名即短名域）
    const root = mkRoot(BASE(BAD_TOOL_YAML));
    const err = validateAt(root);
    expect(err).not.toBeNull();
    expect(err!.issues.some((i) => i.field.includes('agents'))).toBe(true);
  });

  it('defaultSkills 引用不存在子目录 → issue', () => {
    const root = mkRoot(BASE(BAD_SKILL_YAML));
    const err = validateAt(root);
    expect(err).not.toBeNull();
    expect(err!.issues.some((i) => i.field.includes('agents'))).toBe(true);
  });

  it('坏 YAML → issue 不抛裸错', () => {
    const root = mkRoot(BASE('not: [valid'));
    const err = validateAt(root);
    expect(err).not.toBeNull();
  });
});
