// electron/src/main/storage/memories/tokenize.ts
// jieba 分词共享模块（spec §5.3）：索引侧与查询侧的唯一分词实现。
// FTS5 unicode61 对中文按字切分导致 BM25 无意义，故写入侧存「jieba 分词后的空格串」，
// 查询侧用同一 cut() 生成 MATCH 表达式——同源性由契约测试锁死。
//
// 适配说明（brief §11.3）：@node-rs/jieba@2.x 不再导出顶层 cut()，
// 须经 Jieba.withDict(dict).cut(text, hmm) 调用；实例惰性单例避免重复加载词典。
// 此外 jieba 会把英文之间的空格、嵌入的 `"` 切成独立 token，需要合并到前后 token，
// 否则 FTS5 MATCH 表达式会因独立 `"` 触发语法错误（参见 tests/memory/tokenize-contract.test.ts）。
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

// 单例 Jieba 实例：首次按需惰性加载内置词典（约 5MB），后续调用复用
let jiebaInstance: Jieba | null = null;
function getJieba(): Jieba {
  if (!jiebaInstance) {
    jiebaInstance = Jieba.withDict(dict);
  }
  return jiebaInstance;
}

/** 内部唯一分词入口；HMM=true 处理未登录词（人名、新词等） */
function tokens(text: string): string[] {
  const raw = getJieba().cut(text, true);
  // 第一遍：trim + 过滤纯空白 token（jieba 在英文之间会输出 ' ' 单字符 token）
  const filtered: string[] = [];
  for (const t of raw) {
    const trimmed = t.trim();
    if (trimmed.length > 0) filtered.push(trimmed);
  }
  // 第二遍：合并「alphanum [punct-only]+ alphanum」为单个 token
  // 理由：jieba 会把嵌入的 `"`、标点切成独立片段，对 FTS5 MATCH 表达式而言
  // 独立 `"` token 会触发语法错误；并入相邻 token 后 query 侧可正确表达短语字面量
  const result: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const cur = filtered[i] ?? '';
    if (/^[^\p{L}\p{N}]+$/u.test(cur)) {
      // 孤立纯标点 token（无 alphanum 邻居）：保留独立，避免丢信息
      if (result.length > 0) {
        result[result.length - 1] += cur;
      } else {
        result.push(cur);
      }
      continue;
    }
    // alphanum token：检查是否紧跟「punct-only → alphanum」模式，若是则一并合并
    let merged = cur;
    let j = i + 1;
    while (
      j + 1 < filtered.length &&
      /^[^\p{L}\p{N}]+$/u.test(filtered[j] ?? '') &&
      !/^[^\p{L}\p{N}]+$/u.test(filtered[j + 1] ?? '')
    ) {
      merged += (filtered[j] ?? '') + (filtered[j + 1] ?? '');
      j += 2;
    }
    result.push(merged);
    i = j - 1; // for 循环会 ++，此处减 1 让下一轮从 j 开始
  }
  return result;
}

/** 索引侧：文本 → jieba 分词空格串（写入 memories_fts.content 列） */
export function tokenizeForIndex(text: string): string {
  return tokens(text).join(' ');
}

/** 查询侧：查询文本 → FTS5 MATCH 表达式（token 双引号包裹，空格 = AND） */
export function buildMatchExpr(query: string): string {
  return tokens(query)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}
