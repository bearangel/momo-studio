// pptx 模板填充测试（spec §14.9-3，office_fill_ppt_template 底座 fillPptTemplate）。
// fixture 用 pptxgenjs defineSlideMaster 真实生成 2 页品牌模板（title/body 占位符 +
// 背景色 + logo 图）——真实库造，不手写 XML；断言一律 unzip 后对真实 OOXML 部件做，
// 并用逐部件字节对比锁死保真铁律：除被填充页 slide XML 外（母版/版式/主题/媒体/
// rels/presentation/notes）全部字节不变，模板 buffer 本身不被改动（另存语义）。
import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import PptxGenJS from 'pptxgenjs';
import {
  fillPptTemplate,
  parsePptTemplateFills,
} from '../../../../src/main/agent/tools/office/pptx-zip';

// 1x1 透明 PNG（母版 logo；pptxgenjs 仅原样嵌入不解析像素）
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 2 页品牌模板：母版带 title/body 占位符 + 深底色 + logo 图；两页各有旧内容 */
async function buildBrandTemplate(): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.defineSlideMaster({
    title: 'BRAND',
    background: { color: '1F3864' },
    objects: [
      {
        placeholder: {
          options: { name: 'title', type: 'title', x: 0.5, y: 0.4, w: 9, h: 1 },
          text: '母版标题占位',
        },
      },
      {
        placeholder: {
          options: { name: 'body', type: 'body', x: 0.7, y: 1.7, w: 8.6, h: 3.6 },
          text: '母版正文占位',
        },
      },
      {
        image: { x: 9.2, y: 0.25, w: 0.5, h: 0.5, data: `image/png;base64,${PNG_1PX.toString('base64')}` },
      },
    ],
  });
  const s1 = pptx.addSlide({ masterName: 'BRAND' });
  s1.addText('旧标题一', { placeholder: 'title', fontSize: 30, bold: true, color: 'FFC000' });
  s1.addText(
    [
      { text: '旧要点一', options: { bullet: true } },
      { text: '旧要点二', options: { bullet: true } },
    ],
    { placeholder: 'body', fontSize: 16 },
  );
  const s2 = pptx.addSlide({ masterName: 'BRAND' });
  s2.addText('旧标题二', { placeholder: 'title', fontSize: 24 });
  s2.addText([{ text: '旧内容甲', options: { bullet: true } }], { placeholder: 'body' });
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(out as Uint8Array);
}

function entryText(zip: AdmZip, name: string): string {
  const e = zip.getEntry(name);
  if (!e) throw new Error(`zip 缺少部件 ${name}；实际有: ${zip.getEntries().map((x) => x.entryName).join(', ')}`);
  return e.getData().toString('utf-8');
}

function fileEntries(zip: AdmZip) {
  return zip.getEntries().filter((e) => !e.isDirectory);
}

/** 从 slide XML 提取含指定 ph type 的首个 sp 块（占位符形态断言入口） */
function spBlockByPh(slideXml: string, phType: string): string {
  const re = /<p:sp>[\s\S]*?<\/p:sp>/g;
  let m = re.exec(slideXml);
  while (m !== null) {
    if (new RegExp(`<p:ph\\b[^>]*\\btype="${phType}"`).test(m[0] ?? '')) return m[0] ?? '';
    m = re.exec(slideXml);
  }
  throw new Error(`slide XML 无 type="${phType}" 占位符 sp 块`);
}

describe('fillPptTemplate 模板填充（spec §14.9-3）', () => {
  it('文本替换生效（旧文本消失）；除两页 slide XML 外全部部件字节不变；模板 buffer 原样', async () => {
    const template = await buildBrandTemplate();
    const snapshot = Buffer.from(template);
    const out = fillPptTemplate(template, [
      { title: '新标题一', bullets: ['新要点1', '新要点2', '新要点3'] },
      { title: '新标题二', bullets: ['新内容乙'] },
    ]);
    // 另存语义：输入 buffer 不被改动
    expect(template.equals(snapshot)).toBe(true);
    const tz = new AdmZip(template);
    const oz = new AdmZip(out);
    const s1 = entryText(oz, 'ppt/slides/slide1.xml');
    expect(s1).toContain('新标题一');
    expect(s1).toContain('新要点1');
    expect(s1).toContain('新要点2');
    expect(s1).toContain('新要点3');
    expect(s1).not.toContain('旧标题一');
    expect(s1).not.toContain('旧要点');
    const s2 = entryText(oz, 'ppt/slides/slide2.xml');
    expect(s2).toContain('新标题二');
    expect(s2).not.toContain('旧标题二');
    expect(s2).toContain('新内容乙');
    // 保真铁律：其余部件逐字节一致（母版/版式/主题/媒体/rels/presentation/notes/docProps）
    const tFiles = fileEntries(tz);
    expect(tFiles.length).toBeGreaterThan(10);
    for (const e of tFiles) {
      if (e.entryName === 'ppt/slides/slide1.xml' || e.entryName === 'ppt/slides/slide2.xml') continue;
      const oe = oz.getEntry(e.entryName);
      expect(oe, `输出缺部件: ${e.entryName}`).toBeDefined();
      expect(oe!.getData().equals(e.getData()), `部件字节漂移: ${e.entryName}`).toBe(true);
    }
    // 输出无新增部件
    expect(fileEntries(oz)).toHaveLength(tFiles.length);
  });

  it('bullets 多段：3 bullets → body 3 个 a:p，每段保留 bullet 样式（buChar）', async () => {
    const template = await buildBrandTemplate();
    const out = fillPptTemplate(template, [{ title: 'T', bullets: ['一', '二', '三'] }, { title: 'T2' }]);
    const s1 = entryText(new AdmZip(out), 'ppt/slides/slide1.xml');
    const body = spBlockByPh(s1, 'body');
    expect((body.match(/<a:p>/g) ?? []).length).toBe(3);
    expect((body.match(/<a:buChar/g) ?? []).length).toBe(3);
    expect(body).toContain('<a:t>一</a:t>');
    expect(body).toContain('<a:t>二</a:t>');
    expect(body).toContain('<a:t>三</a:t>');
    expect(body).not.toContain('旧要点');
  });

  it('bullets 省略：正文保持原样（旧内容仍在）', async () => {
    const template = await buildBrandTemplate();
    const out = fillPptTemplate(template, [{ title: '新' }, { title: '新二' }]);
    const s2 = entryText(new AdmZip(out), 'ppt/slides/slide2.xml');
    expect(s2).toContain('旧内容甲');
  });

  it('slides 少于模板页数：多余页 slide XML 字节不变', async () => {
    const template = await buildBrandTemplate();
    const out = fillPptTemplate(template, [{ title: '只填第一页' }]);
    expect(entryText(new AdmZip(out), 'ppt/slides/slide2.xml')).toBe(
      entryText(new AdmZip(template), 'ppt/slides/slide2.xml'),
    );
  });

  it('样式保留：title run 原 rPr（字号/加粗/色）填充后仍在', async () => {
    const template = await buildBrandTemplate();
    const out = fillPptTemplate(template, [{ title: '样式验证' }, { title: 'x' }]);
    const s1 = entryText(new AdmZip(out), 'ppt/slides/slide1.xml');
    const title = spBlockByPh(s1, 'title');
    expect(title).toContain('sz="3000"');
    expect(title).toContain('b="1"');
    expect(title).toContain('FFC000');
    expect(title).toContain('<a:t>样式验证</a:t>');
  });

  it('XML 转义：title/bullets 含 <>&" 时以实体写入', async () => {
    const template = await buildBrandTemplate();
    const out = fillPptTemplate(template, [{ title: 'a<b>&"c', bullets: ['x<&>y'] }, { title: '第二页' }]);
    const s1 = entryText(new AdmZip(out), 'ppt/slides/slide1.xml');
    expect(s1).toContain('<a:t>a&lt;b&gt;&amp;&quot;c</a:t>');
    expect(s1).toContain('<a:t>x&lt;&amp;&gt;y</a:t>');
  });

  it('空 body 占位符（无 run 段落）填 bullets：逐段插入生效', async () => {
    // pptxgenjs 把母版占位符全量拷进 slide：页级只写 title 时，body sp 为空段落
    // （无 a:r）——恰好覆盖 replaceFirstRun 的无 run 插入回退分支
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    pptx.defineSlideMaster({
      title: 'OT',
      objects: [
        { placeholder: { options: { name: 'title', type: 'title', x: 0.5, y: 0.4, w: 9, h: 1 }, text: 't' } },
        { placeholder: { options: { name: 'body', type: 'body', x: 0.7, y: 1.7, w: 8, h: 3 }, text: 'b' } },
      ],
    });
    const s = pptx.addSlide({ masterName: 'OT' });
    s.addText('只有标题', { placeholder: 'title' });
    const buf = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array);
    const out = fillPptTemplate(buf, [{ title: '新标题', bullets: ['甲', '乙'] }]);
    const s1 = entryText(new AdmZip(out), 'ppt/slides/slide1.xml');
    const body = spBlockByPh(s1, 'body');
    expect((body.match(/<a:p>/g) ?? []).length).toBe(2);
    expect(body).toContain('<a:t>甲</a:t>');
    expect(body).toContain('<a:t>乙</a:t>');
    // 插入位置合规：run 在 endParaRPr 之前（OOXML 段落子元素次序）
    expect(body).toContain('<a:t>甲</a:t></a:r><a:endParaRPr');
  });

  it('错误路径：slides 超模板页数 / 无标题占位符 / 无正文占位符给 bullets', async () => {
    const template = await buildBrandTemplate();
    expect(() => fillPptTemplate(template, [{ title: 'a' }, { title: 'b' }, { title: 'c' }])).toThrow(/超出/);
    // 无占位符页：普通 addText（无 p:ph），真实库可造的最朴素形态
    const plain = new PptxGenJS();
    plain.layout = 'LAYOUT_16x9';
    const ps = plain.addSlide();
    ps.addText('普通文本框', { x: 1, y: 1, w: 5, h: 1 });
    const plainBuf = Buffer.from((await plain.write({ outputType: 'nodebuffer' })) as Uint8Array);
    expect(() => fillPptTemplate(plainBuf, [{ title: 'x' }])).toThrow(/第 1 页无标题占位符/);
    // 母版只定义 title 占位符 → 页内无 body sp（pptxgenjs 会把母版占位符全量
    // 拷进 slide，故「无 body」只能由母版不定义来构造）
    const onlyTitle = new PptxGenJS();
    onlyTitle.layout = 'LAYOUT_16x9';
    onlyTitle.defineSlideMaster({
      title: 'OT',
      objects: [
        { placeholder: { options: { name: 'title', type: 'title', x: 0.5, y: 0.4, w: 9, h: 1 }, text: 't' } },
      ],
    });
    const os = onlyTitle.addSlide({ masterName: 'OT' });
    os.addText('只有标题', { placeholder: 'title' });
    const otBuf = Buffer.from((await onlyTitle.write({ outputType: 'nodebuffer' })) as Uint8Array);
    expect(() => fillPptTemplate(otBuf, [{ title: 'x', bullets: ['a'] }])).toThrow(/第 1 页无正文占位符/);
  });
});

describe('parsePptTemplateFills 入参窄化', () => {
  it('合法形态全通过（bullets 省略 / 给出）', () => {
    expect(parsePptTemplateFills([{ title: 'a' }, { title: 'b', bullets: ['x', 'y'] }])).toEqual([
      { title: 'a' },
      { title: 'b', bullets: ['x', 'y'] },
    ]);
  });
  it('非法形态拒绝：非数组 / 空数组 / 缺 title / bullets 非字符串数组', () => {
    expect(() => parsePptTemplateFills('x')).toThrow(/slides/);
    expect(() => parsePptTemplateFills([])).toThrow(/slides/);
    expect(() => parsePptTemplateFills([{ bullets: ['x'] }])).toThrow(/title/);
    expect(() => parsePptTemplateFills([{ title: 'a', bullets: 'x' }])).toThrow(/bullets/);
    expect(() => parsePptTemplateFills([{ title: 'a', bullets: ['x', 1] }])).toThrow(/bullets\[1\]/);
  });
});
