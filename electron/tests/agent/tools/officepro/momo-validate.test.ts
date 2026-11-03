// momo-validate 行为锁（spec 2026-11-03 §5.2）：zip 完整性 / 必需部件 / XML 良构粗检。
// 夹具用 adm-zip 手工构造（不依赖 vendor 安装）。
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT } from './fixtures';

interface ValidateResult { ok: boolean; errors: string[] }
const { validateOfficeFile } = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-validate/index.js')) as {
  validateOfficeFile: (abs: string) => ValidateResult;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mv-'));

function zipWrite(name: string, entries: Array<[string, string]>): string {
  const zip = new AdmZip();
  for (const [entry, content] of entries) zip.addFile(entry, Buffer.from(content, 'utf-8'));
  const p = path.join(tmp, name);
  zip.writeZip(p);
  return p;
}

const XML = '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="urn:x"></p:presentation>';

describe('momo-validate（结构校验）', () => {
  it('合法最小 pptx → ok', () => {
    const f = zipWrite('ok.pptx', [
      ['[Content_Types].xml', XML],
      ['_rels/.rels', XML],
      ['ppt/presentation.xml', XML],
      ['ppt/slides/slide1.xml', XML],
    ]);
    expect(validateOfficeFile(f)).toEqual({ ok: true, errors: [] });
  });

  it('缺 [Content_Types].xml → 报缺部件', () => {
    const f = zipWrite('no-ct.pptx', [['ppt/presentation.xml', XML], ['_rels/.rels', XML]]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('[Content_Types].xml'))).toBe(true);
  });

  it('根标签未闭合的 xml → 良构错误', () => {
    const broken = '<?xml version="1.0"?><p:presentation xmlns:p="urn:x">';
    const f = zipWrite('broken.pptx', [
      ['[Content_Types].xml', XML], ['_rels/.rels', XML], ['ppt/presentation.xml', broken],
    ]);
    expect(validateOfficeFile(f).ok).toBe(false);
  });

  it('随机字节（非 zip）→ 打不开报损坏', () => {
    const f = path.join(tmp, 'garbage.pptx');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(validateOfficeFile(f).ok).toBe(false);
  });

  it('不支持的扩展名 → 明确报错', () => {
    const r = validateOfficeFile('/tmp/a.exe');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('不支持的扩展名');
  });
});
