// electron/tests/memory/injection.test.ts
// buildPinnedView 注入预算专项用例（spec §11.1 明文缺口——终审修复 F1）：
// 纯函数直测（对象字面量构造 MemoryEntry，不经 DB），锁定口径：
//   1. 全局超预算截断：kept 按序保留 + truncatedCount + 尾注条数
//   2. 全空 parts → 空视图（不注入空段）
//   3. sessionSummary 注入「### 本会话背景摘要」段；超 1000 字符被 slice
//   4. catalog 目录行 30 字预览 + pinnedIds 只含常驻条目
//   5. sessionPinned 注入「### 会话记忆」段（摘要段之后，预算 500）
//   6. catalog 超 30 条：溢出计入 truncatedCount（不再静默丢弃）
import { describe, it, expect } from 'vitest';
import { buildPinnedView } from '../../src/main/memory/injection';
import type { MemoryEntry } from '../../src/main/storage/memories/repo';

// 唯一 id 生成（momo-test-rules：测试构造的 ID 必须真实唯一，杜绝消费方去重误判）
let seq = 0;
function entry(overrides: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  seq += 1;
  return {
    id: `mem-${seq}`,
    rowid: seq,
    scope: 'global',
    workspaceId: null,
    sessionId: null,
    kind: 'rule',
    pinned: true,
    tags: [],
    source: 'user',
    sourceDetail: null,
    confidence: 1,
    useCount: 0,
    lastUsedAt: null,
    createdAt: seq,
    updatedAt: seq,
    ...overrides,
  };
}

describe('buildPinnedView 注入预算', () => {
  it('全局超预算截断：kept 按序保留 + truncatedCount 正确 + 尾注条数', () => {
    // 3 × 900 字符：前两条合计 1800 ≤ 2000 按序保留；第三条会超 2000 被截（truncated=1）
    const e1 = entry({ content: 'A'.repeat(900) });
    const e2 = entry({ content: 'B'.repeat(900) });
    const e3 = entry({ content: 'C'.repeat(900) });
    const view = buildPinnedView({
      globalPinned: [e1, e2, e3], workspacePinned: [], sessionPinned: [], sessionSummary: null, catalog: [],
    });
    expect(view.pinnedIds).toEqual([e1.id, e2.id]);
    expect(view.truncatedCount).toBe(1);
    expect(view.hint).toContain(e1.content);
    expect(view.hint).toContain(e2.content);
    expect(view.hint).not.toContain(e3.content);
    expect(view.hint).toContain('另有 1 条记忆未注入');
  });

  it('全空 parts：返回空视图（不注入空段）', () => {
    const view = buildPinnedView({ globalPinned: [], workspacePinned: [], sessionPinned: [], sessionSummary: null, catalog: [] });
    expect(view).toEqual({ hint: '', truncatedCount: 0, pinnedIds: [] });
  });

  it('会话摘要：注入「### 本会话背景摘要」段；超 1000 字符被 slice', () => {
    const short = buildPinnedView({
      globalPinned: [], workspacePinned: [], sessionPinned: [],
      sessionSummary: { summary: '短摘要应全部注入', coveredUntil: 1, updatedAt: 1 },
      catalog: [],
    });
    expect(short.hint).toContain('### 本会话背景摘要');
    expect(short.hint).toContain('短摘要应全部注入');

    // 1000 字符之后的标记不应出现（BUDGET_SESSION 截断）
    const marker = 'TAIL_MARKER_BEYOND_1000';
    const long = buildPinnedView({
      globalPinned: [], workspacePinned: [], sessionPinned: [],
      sessionSummary: { summary: 'x'.repeat(1000) + marker, coveredUntil: 1, updatedAt: 1 },
      catalog: [],
    });
    expect(long.hint).not.toContain(marker);
  });

  it('目录行 30 字预览 + pinnedIds 只含常驻条目（不含 catalog）', () => {
    const pinned = entry({ content: '常驻规范条目' });
    const cat = entry({ kind: 'knowledge', pinned: false, content: 'X'.repeat(30) + '超出预览长度的尾部内容' });
    const view = buildPinnedView({
      globalPinned: [pinned], workspacePinned: [], sessionPinned: [], sessionSummary: null, catalog: [cat],
    });
    expect(view.hint).toContain('### 可检索记忆目录');
    expect(view.hint).toContain(`- (knowledge) ${'X'.repeat(30)}`);
    expect(view.hint).not.toContain('超出预览长度的尾部内容');
    expect(view.pinnedIds).toEqual([pinned.id]);
  });

  it('会话记忆段：session pinned 注入「### 会话记忆」且置于摘要段之后；超 500 字符截断计入 truncatedCount', () => {
    const sp1 = entry({ scope: 'session', workspaceId: 'ws1', sessionId: 's1', content: '会话常驻：优先用 vitest' });
    const sp2 = entry({ scope: 'session', workspaceId: 'ws1', sessionId: 's1', content: 'B'.repeat(600) });
    const view = buildPinnedView({
      globalPinned: [], workspacePinned: [], sessionPinned: [sp1, sp2],
      sessionSummary: { summary: '本会话摘要正文', coveredUntil: 1, updatedAt: 1 },
      catalog: [],
    });
    expect(view.hint).toContain('### 会话记忆');
    expect(view.hint).toContain('会话常驻：优先用 vitest');
    // 第二条 600 字超 500 预算被截断（第一条已占用部分预算）
    expect(view.hint).not.toContain(sp2.content.slice(0, 100));
    expect(view.truncatedCount).toBe(1);
    expect(view.pinnedIds).toEqual([sp1.id]);
    // 段顺序：「### 会话记忆」置于「### 本会话背景摘要」之后
    expect(view.hint.indexOf('### 本会话背景摘要')).toBeLessThan(view.hint.indexOf('### 会话记忆'));
  });

  it('目录超 30 条：溢出计入 truncatedCount（不再静默丢弃）', () => {
    const catalog = Array.from({ length: 35 }, (_, i) =>
      entry({ kind: 'knowledge', pinned: false, content: `目录条目 ${String(i).padStart(2, '0')}` }));
    const view = buildPinnedView({
      globalPinned: [], workspacePinned: [], sessionPinned: [], sessionSummary: null, catalog,
    });
    // 35 条合并限量 30，溢出 5 条计入；行短不触发 1000 字符预算
    expect(view.truncatedCount).toBe(5);
  });
});
