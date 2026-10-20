// plugins/codegraph/service/index.js
//
// v2.0.0 薄化（引擎整合）：索引/查询能力整体移交 MCP server（mcp.json 声明，
// 引擎 bundle 自带 Node 24 运行时）。本 service 仅剩面板状态卡数据源——
// fs 统计 .momo-codegraph 目录（无引擎依赖、无宿主反向依赖）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_WALK = 5000; // 目录遍历上限（防慢盘大仓卡面板请求）

module.exports.createService = function (pluginCtx) {
  function dataDir() {
    return pluginCtx.getDataDir();
  }

  function cfgRoot() {
    const cfg = pluginCtx.getConfig() || {};
    const r =
      (typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim() !== '' && cfg.workspaceRoot) ||
      (pluginCtx.workspace && pluginCtx.workspace.directoryPath);
    if (!r || typeof r !== 'string') return null;
    return path.resolve(r);
  }

  function dirStats(dir) {
    if (!fs.existsSync(dir)) return { exists: false, bytes: 0, files: 0 };
    let bytes = 0;
    let files = 0;
    const queue = [dir];
    while (queue.length > 0 && files < MAX_WALK) {
      const cur = queue.shift();
      for ( const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const abs = path.join(cur, ent.name);
        if (ent.isDirectory()) queue.push(abs);
        else {
          try { bytes += fs.statSync(abs).size; files += 1; } catch { /* 并发删除忽略 */ }
        }
      }
    }
    return { exists: true, bytes, files };
  }

  return {
    async start() {
      fs.mkdirSync(dataDir(), { recursive: true });
    },
    async stop() {},
    async handle(method, params) {
      if (method !== 'stats') {
        throw new Error(`codegraph service v2 仅支持 stats（索引/查询走 MCP server）: ${method}`);
      }
      void params;
      const root = cfgRoot();
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'momo-plugin.json'), 'utf-8'));
      const engineVersion = (manifest.codegraph && manifest.codegraph.engineVersion) || null;
      if (!root) {
        return { workspaceRoot: null, engineVersion, index: { exists: false, bytes: 0, files: 0 }, hint: 'workspaceRoot 未配置且无工作区上下文' };
      }
      return {
        workspaceRoot: root,
        engineVersion,
        index: dirStats(path.join(root, '.momo-codegraph')),
        mcpServer: 'codegraph',
      };
    },
  };
};
