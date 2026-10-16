// plugins/codegraph/tools/explore.js
//
// codegraph explore 工具（P5，spec §2.5/§8.4）——符号→定义+调用方+blast radius。
// child 进程侧按需增量扫描（计划 D2）；文件名=短名（安装链交叉引用约定）。
'use strict';

const path = require('node:path');
const { createIndexer } = require('../lib/indexer.js');

function renderExplore(e) {
  const lines = [];
  lines.push(`# 符号 ${e.symbol}（${e.definition.kind}）`);
  lines.push('');
  lines.push(`定义：${path.basename(e.definition.file)}:${e.definition.line}`);
  lines.push('```');
  lines.push(e.definition.snippet);
  lines.push('```');
  lines.push('');
  if (e.callers.length === 0) {
    lines.push('直接调用方：无（未被索引内文件调用）');
  } else {
    lines.push(`直接调用方（${e.callers.length}）：`);
    for (const c of e.callers.slice(0, 20)) {
      lines.push(`- ${path.basename(c.file)}${c.lines.length ? ':' + c.lines.join(',') : ''}`);
    }
  }
  lines.push('');
  if (e.blastRadius.length === 0) {
    lines.push('blast radius：无上游传递调用方');
  } else {
    lines.push(`blast radius（上游传递闭包，${e.blastRadius.length} 文件）：`);
    for (const f of e.blastRadius.slice(0, 30)) lines.push(`- ${path.basename(f)}`);
  }
  lines.push('');
  lines.push('> 近似调用图（regex 扫描，非静态分析）——跨文件同名符号会合并，判定前请读源码确认。');
  return lines.join('\n');
}

module.exports.createTools = function (pluginCtx) {
  let cachedRoot = null;
  let idx = null;
  let lastScanAt = 0;
  const RESCAN_INTERVAL_MS = 15_000;

  function indexer() {
    const cfg = pluginCtx.getConfig() || {};
    const root = cfg.workspaceRoot;
    if (!root || typeof root !== 'string') {
      throw new Error('codegraph：workspaceRoot 未配置（设置 → 插件 → Codegraph 填索引根目录）');
    }
    if (!idx || cachedRoot !== root) {
      idx = createIndexer({ root, maxFiles: typeof cfg.maxFiles === 'number' ? cfg.maxFiles : undefined });
      cachedRoot = root;
    }
    if (Date.now() - lastScanAt > RESCAN_INTERVAL_MS) {
      idx.scanFull();
      lastScanAt = Date.now();
    }
    return idx;
  }

  module.exports._indexer = indexer;

  return {
    getDefs() {
      return [
        {
          name: 'explore',
          description:
            '查代码图谱：给定符号名，返回定义源码位置与片段、直接调用方、上游 blast radius（近似 regex 调用图）。回答「X 被谁调用/改动影响面」时优先用本工具而非 grep。',
          inputSchema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: '符号名（函数/类/方法/箭头常量）' } },
            required: ['symbol'],
          },
        },
      ];
    },
    getCatalog() {
      return [
        { name: 'explore', displayName: '图谱查询', description: '符号定义+调用方+blast radius', category: '代码图谱', categoryEmoji: '', defaultOn: false },
      ];
    },
    handles(name) {
      return name === 'explore';
    },
    async execute(name, args) {
      const symbol = String((args && args.symbol) || '').trim();
      if (!symbol) throw new Error('codegraph explore：缺少 symbol 参数');
      const e = indexer().explore(symbol);
      if (!e) {
        throw new Error(
          `codegraph：符号「${symbol}」未收录（可能：未被索引/在忽略目录/非函数类符号）。可用 plugin:codegraph/status 查看索引范围。`,
        );
      }
      return renderExplore(e);
    },
  };
};
