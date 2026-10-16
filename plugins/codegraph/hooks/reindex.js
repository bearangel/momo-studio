// plugins/codegraph/hooks/reindex.js
//
// postToolUse → 增量重索引队列生产者（P5 计划 D4，spec §8.5）：
// agent 写文件（write_file/apply_patch 等）→ 本 hook 把 {paths} 追加进
// dataDir/reindex-queue.json → service watcher 消费 → 面板下次拉图即新。
// 队列文件原子写（tmp+rename）防半读；仅收录 workspaceRoot 内路径。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports.handle = async function (payload, pluginCtx) {
  try {
    const cfg = pluginCtx.getConfig() || {};
    const root = require('node:path').resolve(String(cfg.workspaceRoot)); // M2：归一（尾斜杠守卫前提）
    if (!root || typeof root !== 'string') return null; // 未配置——链路静默待命
    const ev = payload || {};
    // postToolUse 载荷（P3 spec §5.4）：{ toolName, args, success, workspaceId }
    const candidates = [];
    const argPaths = ev.args && typeof ev.args === 'object' ? ev.args : {};
    for (const key of ['path', 'file_path', 'filePath', 'file']) {
      if (typeof argPaths[key] === 'string') candidates.push(argPaths[key]);
    }
    if (Array.isArray(argPaths.paths)) {
      for (const p of argPaths.paths) if (typeof p === 'string') candidates.push(p);
    }
    const inRoot = candidates.filter((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
      return abs === root || abs.startsWith(root + path.sep);
    });
    if (inRoot.length === 0) return null;

    const dataDir = pluginCtx.getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const q = path.join(dataDir, 'reindex-queue.json');
    let prev = [];
    try {
      const raw = JSON.parse(fs.readFileSync(q, 'utf-8'));
      if (Array.isArray(raw.paths)) prev = raw.paths;
    } catch {
      // 无旧队列
    }
    const merged = [...new Set([...prev, ...inRoot])].slice(0, 500);
    const tmp = q + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ paths: merged, at: Date.now() }), 'utf-8');
    fs.renameSync(tmp, q);
    return null; // 通知型 hook（不参与决策）
  } catch {
    return null; // 队列生产失败不扰动工具链（fail-open）
  }
};
