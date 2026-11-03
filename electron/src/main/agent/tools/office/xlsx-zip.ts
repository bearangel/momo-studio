// xlsx 图表摘要读取（spec 2026-11-03 §6 下线生成后仅保留读路径）。
// office_write_excel / add_chart 注入管线（snapshotChartParts / injectCharts /
// refreshChartCaches 等写侧能力）已下线；其能力由 office-pro 插件 momo-chart 承接。
// 本文件当前仅服务 office_read 预览头部的图表提示数据源（前缀无关解析，损坏跳过）。

import AdmZip from 'adm-zip';

function xmlUnescapeAttr(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ────────────────────────────────────────────────────────────────────────────
// 图表摘要（spec §14.8-4）：office_read 预览头部的图表提示数据源
// ────────────────────────────────────────────────────────────────────────────

/** 图表摘要：类型/标题/引用（前缀无关解析；损坏图表跳过不炸）。
 *  refs 按文档出现序去重；catRefs/valRefs/nameRefs 为能从父节点（ser > cat/val/tx
 *  下的 strRef/numRef）判定的分类引用——渲染端能则标注 类别/数值/序列名。 */
export interface ChartSummary {
  kind: 'bar' | 'line' | 'pie' | 'other';
  title: string | null;
  refs: string[];
  catRefs?: string[];
  valRefs?: string[];
  nameRefs?: string[];
}

/** 单个 chart XML → 摘要；无 chart 元素的垃圾内容返回 null（调用方跳过）。
 *  正则与 refreshChartXmlCaches 同款双形态（<(?:c:)?f> 式），openpyxl 默认命名
 *  空间产物同样可解析。 */
function summarizeChartXml(xml: string): ChartSummary | null {
  if (!/<(?:c:)?chart[\s>]/.test(xml)) return null;
  // 类型按节点判定：bar 含横向（barDir="bar"）；组合图（bar+line 同图）取 bar 优先
  let kind: ChartSummary['kind'] = 'other';
  if (/<(?:c:)?barChart[\s>]/.test(xml)) kind = 'bar';
  else if (/<(?:c:)?lineChart[\s>]/.test(xml)) kind = 'line';
  else if (/<(?:c:)?pieChart[\s>]/.test(xml)) kind = 'pie';

  // 标题：title 块内首个文本 run（a:t；openpyxl 默认命名空间产物为无前缀 <t>）
  let title: string | null = null;
  const titleBlock = xml.match(/<(?:c:)?title\b[\s\S]*?<\/(?:c:)?title>/);
  if (titleBlock !== null) {
    const t = (titleBlock[0] ?? '').match(/<(?:a:)?t>([^<]*)<\/(?:a:)?t>/);
    if (t !== null) {
      const text = xmlUnescapeAttr(t[1] ?? '');
      if (text !== '') title = text;
    }
  }

  const refs: string[] = [];
  const seen = new Set<string>();
  const nameRefs: string[] = [];
  const catRefs: string[] = [];
  const valRefs: string[] = [];
  const addRef = (raw: string, bucket: string[] | null): void => {
    const ref = xmlUnescapeAttr(raw.trim());
    if (ref === '') return;
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
    if (bucket !== null && !bucket.includes(ref)) bucket.push(ref);
  };

  // refs 取全部 f 元素（按出现序去重）；分类只认 ser 容器内的 tx/cat/val
  // （title 的 strRef 引用不属于任何桶 → 渲染端退化为按出现序列出）
  const F_ALL_RE = /<(?:c:)?f>([\s\S]*?)<\/(?:c:)?f>/g;
  for (const fm of xml.match(F_ALL_RE) ?? []) {
    addRef(fm.replace(/^<(?:c:)?f>/, '').replace(/<\/(?:c:)?f>$/, ''), null);
  }
  const SER_RE = /<(?:c:)?ser\b[^>]*>([\s\S]*?)<\/(?:c:)?ser>/g;
  for (const ser of xml.match(SER_RE) ?? []) {
    const CONTAINER_RE = /<(?:c:)?(tx|cat|val)\b[^>]*>([\s\S]*?)<\/(?:c:)?(?:tx|cat|val)>/g;
    for (const container of ser.match(CONTAINER_RE) ?? []) {
      const nameMatch = container.match(/^<(?:c:)?(tx|cat|val)\b/);
      const containerName = nameMatch === null ? '' : nameMatch[1] ?? '';
      const bucket = containerName === 'tx' ? nameRefs : containerName === 'cat' ? catRefs : containerName === 'val' ? valRefs : null;
      const F_IN_RE = /<(?:c:)?f>([\s\S]*?)<\/(?:c:)?f>/g;
      for (const fm of container.match(F_IN_RE) ?? []) {
        addRef(fm.replace(/^<(?:c:)?f>/, '').replace(/<\/(?:c:)?f>$/, ''), bucket);
      }
    }
  }

  const summary: ChartSummary = { kind, title, refs };
  if (nameRefs.length > 0) summary.nameRefs = nameRefs;
  if (catRefs.length > 0) summary.catRefs = catRefs;
  if (valRefs.length > 0) summary.valRefs = valRefs;
  return summary;
}

/** 提取全部 chart 部件摘要（chartN 按数值序，与部件编号一致）；损坏部件跳过。 */
export function extractChartSummaries(buf: Buffer): ChartSummary[] {
  const zip = new AdmZip(buf);
  const chartNum = (name: string): number => {
    const m = name.match(/^xl\/charts\/chart(\d+)\.xml$/);
    return m === null ? 0 : parseInt(m[1] ?? '0', 10);
  };
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && chartNum(e.entryName) > 0)
    .sort((a, b) => chartNum(a.entryName) - chartNum(b.entryName));
  const summaries: ChartSummary[] = [];
  for (const e of entries) {
    const s = summarizeChartXml(zip.readAsText(e.entryName));
    if (s !== null) summaries.push(s);
  }
  return summaries;
}
