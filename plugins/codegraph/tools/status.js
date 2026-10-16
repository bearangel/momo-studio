// plugins/codegraph/tools/status.js
//
// codegraph status 工具——索引摘要（root/文件/符号/边/最近索引时间）。
'use strict';

const { createIndexer } = require('../lib/indexer.js');

module.exports.createTools = function (pluginCtx) {
  let cachedRoot = null;
  let idx = null;

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
      return [
        'codegraph status',
        `- root: ${cfg.workspaceRoot}`,
        `- files: ${g.stats.files}, symbols: ${g.stats.symbols}, edges: ${g.stats.edges}`,
        `- lastIndexedAt: ${new Date(g.stats.lastIndexedAt).toISOString()}`,
        '- engine: builtin regex indexer（近似调用图）',
      ].join('\n');
    },
  };
};
