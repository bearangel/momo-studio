// plugins/codegraph/tools/status.js
//
// codegraph status 工具——索引摘要（root/文件/符号/边/最近索引时间）。
// C1 修复：与 explore 同款按需扫描（私有实例须自己扫——status 是 LLM 的
// 诊断面，零值输出会系统性误导「索引为空」）。
'use strict';

const { createIndexer } = require('../lib/indexer.js');

module.exports.createTools = function (pluginCtx) {
  let cachedRoot = null;
  let idx = null;
  let lastScanAt = 0;
  const RESCAN_INTERVAL_MS = 15_000;

  function indexer() {
    const cfg = pluginCtx.getConfig() || {};
    // 工作空间维度 v1.1（spec §4.4）：留空默认跟随工作区目录；显式值优先
    const root = (typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim() !== '' && cfg.workspaceRoot)
      || (pluginCtx.workspace && pluginCtx.workspace.directoryPath);
    if (!root || typeof root !== 'string') {
      throw new Error('codegraph：workspaceRoot 未配置且无工作区上下文（留空即跟随工作区目录）');
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

  return {
    getDefs() {
      return [
        {
          name: 'status',
          description: '返回 codegraph 索引状态摘要（根目录/文件数/符号数/调用边数/最近索引时间）。',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
    },
    getCatalog() {
      return [
        { name: 'status', displayName: '图谱状态', description: '索引摘要', category: '代码图谱', categoryEmoji: '', defaultOn: false },
      ];
    },
    handles(name) {
      return name === 'status';
    },
    async execute() {
      const cfg = pluginCtx.getConfig() || {};
      const g = indexer().graph();
      const shownRoot = (typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim() !== '' && cfg.workspaceRoot)
        || (pluginCtx.workspace && pluginCtx.workspace.directoryPath);
      return [
        'codegraph status',
        `- root: ${shownRoot}`,
        `- files: ${g.stats.files}, symbols: ${g.stats.symbols}, edges: ${g.stats.edges}`,
        `- lastIndexedAt: ${new Date(g.stats.lastIndexedAt).toISOString()}`,
        '- engine: builtin regex indexer（近似调用图）',
      ].join('\n');
    },
  };
};
