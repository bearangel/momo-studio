// electron/src/main/agent/tools/shared/stream-decode.ts
//
// 子进程输出的流式 UTF-8 解码器（bash / git 共用）。
//
// 背景：`chunk.toString('utf-8')` 逐 chunk 解码在多字节字符被 pipe 边界切开时
// 会各自解出 U+FFFD（真实会话表现为中文乱码）。StringDecoder 内部缓存不完整
// 的尾字节，跨 chunk 拼接后再解码，end() 时冲出不完整尾字节。
//
// 截断语义：按**字符**累计到 limit（与旧实现 string.length 口径一致——UTF-16
// 码元计数，BMP 内一字一元），超出部分丢弃并置 truncated，后续写入不再累加
// （仍需继续喂 decoder 以保持字节状态一致，且调用方可能继续收到 chunk）。

import { StringDecoder } from 'node:string_decoder';

export interface Utf8Collector {
  write(chunk: Buffer): void;
  /** close 时调用：冲出不完整尾字节 */
  end(): void;
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * 创建一个按字符上限累计的流式 UTF-8 收集器。
 *
 * @param limit 累计字符上限，超出即截断（`truncated = true`）。
 */
export function createUtf8Collector(limit: number): Utf8Collector {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let truncated = false;
  let ended = false;

  // 追加一段已解码文本；超出剩余配额时只取配额内部分并置截断标记。
  const append = (decoded: string): void => {
    if (decoded.length === 0) return;
    const remaining = limit - text.length;
    if (decoded.length > remaining) {
      if (remaining > 0) text += decoded.slice(0, remaining);
      truncated = true;
      return;
    }
    text += decoded;
  };

  return {
    write(chunk: Buffer): void {
      // 无论是否已截断都喂给 decoder：保持解码器的尾字节缓存状态一致
      const decoded = decoder.write(chunk);
      if (truncated) return;
      append(decoded);
    },
    end(): void {
      if (ended) return;
      ended = true;
      const tail = decoder.end();
      if (truncated) return;
      append(tail);
    },
    get text(): string {
      return text;
    },
    get truncated(): boolean {
      return truncated;
    },
  };
}
