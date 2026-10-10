// electron/tests/agent/builtin-yaml-tier1.test.ts
// builtin agent YAML 契约（spec §4.5）：全部内置 YAML 的 defaultTools ⊇ Tier 1
// （白名单强执行后 builtin 不丢公共默认能力）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';

const yamlDir = path.resolve(__dirname, '../../resources/agents');

describe('builtin agent YAML ⊇ Tier 1', () => {
  const files = fs.readdirSync(yamlDir).filter((f) => f.endsWith('.yaml'));

  it('resources/agents 下有 8 个 YAML', () => {
    expect(files).toHaveLength(8);
  });

  for (const f of files) {
    it(`${f} defaultTools 覆盖 Tier 1 全集`, () => {
      const raw = load(fs.readFileSync(path.join(yamlDir, f), 'utf-8')) as {
        spec?: { defaultTools?: Array<{ kind?: string; ref?: string }> };
      };
      const refs = (raw.spec?.defaultTools ?? []).map((t) => t.ref);
      for (const t of SAFE_MINIMUM_TOOLS) {
        expect(refs).toContain(t);
      }
    });
  }
});
