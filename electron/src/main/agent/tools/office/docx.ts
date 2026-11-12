// Word 读取（spec 2026-11-03 §6 下线生成后仅保留读路径）：mammoth 提取
// （结构保真、样式丢弃——spec §12 边界）。读取图片占位 [图片]（mammoth 默认
// inline base64 data URI 会撑爆上下文）。生成能力由 office-pro 插件承接。
// B 方案收口：入参从磁盘路径改为字节缓冲（office-tools 经内容通道读取 +
// 密文安全闸后传入——本模块不再裸触 fs）。

import mammoth from 'mammoth';

export async function readDocx(data: Buffer): Promise<string> {
  const { value } = await mammoth.convertToMarkdown({ buffer: data });
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]');
}
