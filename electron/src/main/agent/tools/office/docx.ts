// Word 读取（spec 2026-11-03 §6 下线生成后仅保留读路径）：mammoth 提取
// （结构保真、样式丢弃——spec §12 边界）。读取图片占位 [图片]（mammoth 默认
// inline base64 data URI 会撑爆上下文）。生成能力由 office-pro 插件承接。

import mammoth from 'mammoth';

export async function readDocx(abs: string): Promise<string> {
  const { value } = await mammoth.convertToMarkdown({ path: abs });
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]');
}
