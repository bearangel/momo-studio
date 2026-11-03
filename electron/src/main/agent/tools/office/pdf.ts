// electron/src/main/agent/tools/office/pdf.ts
// PDF 读取（spec 2026-11-03 §6 下线生成后仅保留读路径）：pdfjs-dist（v3 UMD
// CJS，Node fake-worker 路径，verbosity 0 压噪）逐页提取。
// 扫描版（无文本层）读取明确报错。仅用 getTextContent，不触渲染，无需 canvas。

import fs from 'node:fs';
import * as pdfjsLib from 'pdfjs-dist';

export async function readPdf(abs: string, signal?: AbortSignal): Promise<string> {
  const data = new Uint8Array(fs.readFileSync(abs));
  // Node 运行时约定：isEvalSupported/useWorkerFetch/disableFontFace 关掉浏览器侧
  // 能力；verbosity 0 压制 fake-worker 等告警噪声（测试输出必须干净）
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      // 循环点抛已中断（spec §7）：对齐 bash/webfetch 的 resolve 先例，让 office_read catch 透传
      if (signal?.aborted) throw new Error('已中断');
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // TextItem | TextMarkedContent 联合类型：'str' in 收窄
      pageTexts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').trim());
    }
    if (pageTexts.every((t) => t.length === 0)) {
      throw new Error('PDF 无文本层（疑似扫描版，无法提取文本）');
    }
    return pageTexts.map((t, i) => `## 第 ${i + 1} 页\n${t}`).join('\n\n');
  } finally {
    await doc.cleanup();
  }
}
