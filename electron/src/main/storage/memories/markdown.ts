// electron/src/main/storage/memories/markdown.ts
// 记忆导出/导入 Markdown（v2.2 P3，spec §7.2/§10）：
//   - 导出：一层记忆全量 → 人类可读 Markdown（可再导入）
//       # 记忆导出（层名）
//       YYYY-MM-DD HH:mm
//
//       ## [kind|source|pinned] content 首行
//       content 续行（多行内容原样保留）
//       - tag（每个标签一行，缀于段尾）
//   - 导入：逐 `## ` 段解析；source 固定 'user'（导入即用户资产，导出头中的 source 仅溯源展示）；
//     格式不符段计入 skipped；同 scope 去重复用 Task 1 的无 touch 检索语义（top3 双向包含）。
// 导入目标 = 传入 scope 本层（global→global / workspace→该 workspaceId）；session 层拒绝
// （会话记忆随会话级联删除、导出文件不含 sessionId 映射，导入无稳定落点）。
import { insertMemory, listMemories, type MemoryListScope, type MemoryEntry } from './repo';
import { searchMemories } from './search';

// 去重常量——与 memory/extraction.ts 同源语义（40 字前缀检索 + top3 + 首 20 字双向包含）。
// 两处各自持有常量（提取域与存储域不互相 import），值变化时需双侧同步。
const DEDUP_PREFIX_LEN = 40;
const DEDUP_HITS = 3;
const OVERLAP_LEN = 20;

/** 层名（导出标题 + 语义展示） */
const LAYER_NAME: Record<MemoryListScope['kind'], string> = {
  global: '全局',
  workspace: '工作空间',
  session: '会话',
};

/** 段头格式：`## [kind|source|pinned] content首行`——kind/pinned 严格枚举（影响落库数据），source 宽松（导入时忽略） */
const HEADER_RE = /^## \[(rule|preference|knowledge|summary)\|[^|\]]+\|(pinned|unpinned)\] ?(.*)$/;

interface ParsedSegment {
  kind: MemoryEntry['kind'];
  pinned: boolean;
  content: string;
  tags: string[];
}

export function exportMemoriesMarkdown(
  scope: MemoryListScope,
): { filename: string; content: string } {
  const entries = listMemories(scope);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const d = new Date();
  const dateLine = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

  const lines: string[] = [`# 记忆导出（${LAYER_NAME[scope.kind]}）`, dateLine, ''];
  for (const e of entries) {
    // content 可能多行——首行随段头输出，续行原样跟随；tags 缀于段尾（`- x` 逐行）
    lines.push(`## [${e.kind}|${e.source}|${e.pinned ? 'pinned' : 'unpinned'}] ${e.content}`);
    for (const t of e.tags) lines.push(`- ${t}`);
    lines.push('');
  }
  // filename 与会话导出同款约定：momo-<域>-<层>-<YYYYMMDD-HHmm>.md
  return { filename: `momo-memory-${scope.kind}-${stamp}.md`, content: lines.join('\n') };
}

export function importMemoriesMarkdown(
  scope: MemoryListScope,
  content: string,
): { imported: number; skipped: number } {
  // session 层拒绝导入（见文件头注释）；UI 侧本页只有 global/workspace 两层 tab
  if (scope.kind === 'session') {
    throw new Error('会话层不支持导入记忆——请导入到全局或工作空间层');
  }

  let imported = 0;
  let skipped = 0;
  for (const segment of splitSegments(content)) {
    const parsed = parseSegment(segment);
    // 坏段（段头格式不符 / kind 非法 / 正文为空）与去重命中均计入 skipped
    if (!parsed || isDuplicate(parsed.content, scope)) {
      skipped++;
      continue;
    }
    insertMemory({
      scope: scope.kind,
      workspaceId: scope.kind === 'workspace' ? scope.workspaceId : null,
      sessionId: null,
      kind: parsed.kind,
      content: parsed.content,
      tags: parsed.tags,
      // pinned 显式透传——真实往返导出时的置顶状态（不按 kind 重推导）
      pinned: parsed.pinned,
      source: 'user',
    });
    imported++;
  }
  return { imported, skipped };
}

/** 按 `## ` 行切段；首个段头之前的内容（标题 + 日期 preamble）不计段 */
function splitSegments(content: string): string[][] {
  const segments: string[][] = [];
  let current: string[] | null = null;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      if (current) segments.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * 单段解析：段头正则 + 段尾 `- ` 连续行剥为 tags，其余续行并入 content。
 * 已知边界：content 末行本身以 `- ` 开头时会被误剥为 tag（真实内容经 UI 单行输入 /
 * LLM 提取产出，不含该形态；如遇手工构造文件该段按已知损失处理）。
 */
function parseSegment(lines: string[]): ParsedSegment | null {
  const m = HEADER_RE.exec(lines[0] ?? '');
  if (!m) return null;
  const body = lines.slice(1);
  // 先剥段尾空行（段间分隔符，不计 content/tags），再剥 `- ` 连续 tag 块——
  // 否则「tag 行 + 空行分隔符」形态会让 tag 剥离失效（往返测试捕获）
  let end = body.length;
  while (end > 0 && (body[end - 1] ?? '').trim() === '') end--;
  let tagStart = end;
  while (tagStart > 0 && /^- [^ ]/.test(body[tagStart - 1] ?? '')) tagStart--;
  const tags = body.slice(tagStart, end).map((l) => (l as string).slice(2));
  const content = [m[3] ?? '', ...body.slice(0, tagStart)].join('\n').trim();
  if (!content) return null;
  return {
    kind: m[1] as MemoryEntry['kind'],
    pinned: m[2] === 'pinned',
    content,
    tags,
  };
}

/**
 * 同 scope 去重：存储层检索天然不 touch（touch 递增只在 provider 包装层），
 * 导入探测不会污染 use_count/last_used_at；scopeKind 把候选收窄到目标层
 * （global 导入只比 global，workspace 导入只比该 workspaceId）。
 */
function isDuplicate(
  content: string,
  scope: { kind: 'global' } | { kind: 'workspace'; workspaceId: string },
): boolean {
  const prefix = content.slice(0, DEDUP_PREFIX_LEN);
  if (!prefix) return false;
  const hits = searchMemories(
    prefix,
    // global 导入时 workspaceId 不参与命中（scopeKind 已收窄到 global 层），空串占位
    { workspaceId: scope.kind === 'workspace' ? scope.workspaceId : '', sessionId: null },
    DEDUP_HITS,
    { scopeKind: scope.kind },
  );
  const candHead = content.slice(0, OVERLAP_LEN);
  return hits.some((hit) => {
    const hitHead = hit.content.slice(0, OVERLAP_LEN);
    return hit.content.includes(candHead) || content.includes(hitHead);
  });
}
