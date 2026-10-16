// plugins/codegraph/service/index.js
//
// codegraph service（P5，spec §2.5/§5.3/§8.2/§8.5）——主进程长驻：
//   - start：读 config.workspaceRoot → 首次全量索引（后台）+ 双 watcher
//     （① workspaceRoot 目录树变更 → 防抖重扫；② dataDir/reindex-queue.json
//     消费——postToolUse hook 的生产队列，计划 D4）
//   - handle RPC（面板 callService / 手动）：
//       graph({symbol}) → 邻域图；stats() → 摘要；explore({symbol}) → 同工具形状；
//       reindex({paths}) → 指定文件增量
//   - stop：关 watcher（§8.6 禁用 → watcher 清理干净）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createIndexer } = require('../lib/indexer.js');

const QUEUE_FILE = 'reindex-queue.json';
const WATCH_DEBOUNCE_MS = 800;

module.exports.createService = function (pluginCtx) {
  let idx = null;
  let root = null;
  let watchers = [];
  let debounceTimer = null;
  let queueTimer = null;
  let ready = false;

  function dataDir() {
    return pluginCtx.getDataDir();
  }
  function queuePath() {
    return path.join(dataDir(), QUEUE_FILE);
  }

  function cfgRoot() {
    const cfg = pluginCtx.getConfig() || {};
    const r = cfg.workspaceRoot;
    if (!r || typeof r !== 'string') {
      throw new Error('codegraph service：workspaceRoot 未配置（设置 → 插件 → Codegraph）');
    }
    return r;
  }

  function ensureIndexer() {
    const r = cfgRoot();
    if (!idx || root !== r) {
      idx = createIndexer({ root: r });
      root = r;
    }
    return idx;
  }

  function consumeQueue() {
    let paths = [];
    try {
      const raw = JSON.parse(fs.readFileSync(queuePath(), 'utf-8'));
      if (Array.isArray(raw.paths)) paths = raw.paths.filter((p) => typeof p === 'string');
    } catch {
      return; // 无队列 / 损坏——忽略
    }
    try {
      fs.rmSync(queuePath(), { force: true });
    } catch {
      // 消费失败下次再试（幂等——重扫无副作用）
    }
    if (paths.length === 0) return;
    const i = ensureIndexer();
    for (const p of paths.slice(0, 200)) {
      const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
      // 越界守卫：只重扫 workspaceRoot 内的路径
      if (abs === root || abs.startsWith(root + path.sep)) i.scanFile(abs);
    }
    if (ready) pluginCtx.logger.info('codegraph：队列增量重扫完成', { count: paths.length });
  }

  function watchQueue() {
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
    } catch {
      return;
    }
    let lastQueueAt = 0;
    try {
      const w = fs.watch(dataDir(), (event, filename) => {
        if (event !== 'change' && event !== 'rename') return;
        if (filename !== QUEUE_FILE) return;
        const now = Date.now();
        if (now - lastQueueAt < 50) return; // 写入抖动合并
        lastQueueAt = now;
        if (queueTimer) clearTimeout(queueTimer);
        queueTimer = setTimeout(consumeQueue, 60);
      });
      w.on('error', () => undefined);
      watchers.push(w);
    } catch {
      // dataDir 不可 watch——轮询兜底（低频）
      queueTimer = setInterval(consumeQueue, 2000);
    }
  }

  function watchRoot() {
    if (!root) return;
    try {
      const w = fs.watch(root, { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            ensureIndexer().scanFull();
          } catch {
            // 扫描失败保持旧索引
          }
        }, WATCH_DEBOUNCE_MS);
      });
      w.on('error', () => undefined);
      watchers.push(w);
    } catch {
      pluginCtx.logger.warn('codegraph：workspaceRoot 目录 watch 失败（仅剩队列驱动增量）', { root });
    }
  }

  return {
    async start() {
      const i = ensureIndexer(); // 校验 config（缺 root 即 throw → 启动失败可见）
      // 首次全量后台化——不阻塞 service start（计划 §6 风险裁定）
      setImmediate(() => {
        try {
          i.scanFull();
          ready = true;
          pluginCtx.logger.info('codegraph：首次全量索引完成', { root });
        } catch (err) {
          pluginCtx.logger.warn('codegraph：首次索引失败', { error: String(err) });
        }
      });
      watchRoot();
      watchQueue();
      // 启动时消费遗留队列（上次会话的未处理增量）
      setImmediate(consumeQueue);
    },
    async stop() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // 已关
        }
      }
      watchers = [];
      if (debounceTimer) clearTimeout(debounceTimer);
      if (queueTimer) {
        clearTimeout(queueTimer);
        clearInterval(queueTimer);
      }
      ready = false;
    },
    async handle(method, params) {
      const i = ensureIndexer();
      switch (method) {
        case 'graph':
          return i.graph(params && params.symbol, (params && params.limit) || 30);
        case 'stats': {
          const g = i.graph();
          return g.stats;
        }
        case 'explore': {
          const symbol = params && params.symbol;
          const e = i.explore(String(symbol || ''));
          if (!e) throw new Error(`符号未收录: ${symbol}`);
          return e;
        }
        case 'reindex': {
          const paths = (params && params.paths) || [];
          for (const p of paths.slice(0, 200)) {
            const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
            if (abs === root || abs.startsWith(root + path.sep)) i.scanFile(abs);
          }
          return { rescanned: paths.length };
        }
        default:
          throw new Error(`codegraph service：未知方法 ${method}`);
      }
    },
  };
};
