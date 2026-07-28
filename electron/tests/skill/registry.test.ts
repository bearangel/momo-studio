// electron/tests/skill/registry.test.ts
//
// SkillRegistry 三层渐进式披露集成测试：
// register → getIndex (L1) → loadFull (L2) → loadResource (L3)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillRegistry } from '../../src/main/skill/registry';

const tmpDir = path.join(os.tmpdir(), `ap-skill-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('skill/registry', () => {
  it('register + getIndex + loadFull 三层渐进式披露', () => {
    // 创建测试 skill 目录
    const skillDir = path.join(tmpDir, 'test-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: 测试技能\nversion: 1.0.0\n---\n\n# 正文内容\n步骤1',
    );

    const registry = new SkillRegistry();
    const def = registry.register(skillDir);
    expect(def.slug).toBe('test-skill');

    // Layer 1: 索引
    const index = registry.getIndex();
    expect(index).toContain('test-skill');
    expect(index).toContain('测试技能');

    // Layer 2: 正文
    const body = registry.loadFull('test-skill');
    expect(body).toContain('正文内容');

    // 检查
    expect(registry.has('test-skill')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });

  it('loadResource 读取附加资源文件（Layer 3）', () => {
    const skillDir = path.join(tmpDir, 'res-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: res-skill\ndescription: 带资源\n---\n正文',
    );
    // 附加资源文件
    fs.mkdirSync(path.join(skillDir, 'refs'));
    fs.writeFileSync(path.join(skillDir, 'refs', 'checklist.md'), '# 检查清单\n- 项A');

    const registry = new SkillRegistry();
    registry.register(skillDir);

    const res = registry.loadResource('res-skill', 'refs/checklist.md');
    expect(res).toContain('检查清单');
    expect(res).toContain('项A');
  });

  it('register 目录缺 SKILL.md 抛错', () => {
    const emptyDir = path.join(tmpDir, 'empty-skill');
    fs.mkdirSync(emptyDir);
    const registry = new SkillRegistry();
    expect(() => registry.register(emptyDir)).toThrow('SKILL.md 不存在');
  });

  it('loadFull 不存在的 skill 抛错', () => {
    const registry = new SkillRegistry();
    expect(() => registry.loadFull('nope')).toThrow('不存在');
  });

  it('loadResource 不存在的 skill 抛错', () => {
    const registry = new SkillRegistry();
    expect(() => registry.loadResource('nope', 'x.md')).toThrow('不存在');
  });

  it('getIndex 空注册表返回空字符串', () => {
    const registry = new SkillRegistry();
    expect(registry.getIndex()).toBe('');
  });
});
