// plugins/codegraph/lib/indexer.js
//
// codegraph 索引引擎（P5，spec §2.5/§8）——regex 近似调用图：
//   符号提取：function / class / 箭头 const / 类方法（非函数 const 不收）
//   调用边：文件内已知符号调用点（v1 文件级粒度）
//   blast radius：目标符号的上游传递闭包（谁调我、谁调调我的人…）
//
// 双实例语义（计划 D2）：tools（child 进程，按需增量扫描）与 service（主进程，
// watcher 常驻）共用本模块——无跨进程状态，一致性由同一实现保证。
// 上限守卫：≤maxFiles 文件 / 单文件 ≤1MB / 跳过 node_modules、dist、.git、二进制。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.momo', 'build', 'out', 'coverage']);
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const BINARY_HEAD = Buffer.from([0x89, 0x50]); // PNG 头样本（够用近似）

/** 符号提取：function / class / 箭头 const / 类方法（非函数 const 不收） */
function scanSource(text) {
  const defs = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const ln = i + 1;
    let m;
    if ((m = line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/))) {
      defs.push({ symbol: m[1], line: ln, kind: 'function' });
    } else if ((m = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      defs.push({ symbol: m[1], line: ln, kind: 'class' });
    } else if (
      (m = line.match(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[\w$]*\s*(?:=>|\()/))
    ) {
      defs.push({ symbol: m[1], line: ln, kind: 'arrow' });
    } else if (
      (m = line.match(/^\s{2,}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/)) &&
      !['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(m[1])
    ) {
      defs.push({ symbol: m[1], line: ln, kind: 'method' });
    }
  });
  return defs;
}

/** 单遍调用点提取：所有 identifier( 出现（名称+行号）——O(文本长度) */
function extractCallSites(text) {
  const out = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      out.push({ name: m[1], line: i + 1 });
    }
  }
  return out;
}

function isCodeFile(abs) {
  if (!CODE_EXTS.has(path.extname(abs))) return false;
  let head;
  try {
    const fd = fs.openSync(abs, 'r');
    head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
  } catch {
    return false;
  }
  return !head.equals(BINARY_HEAD);
}

function walk(root, maxFiles, out) {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= maxFiles) return;
    if (e.name.startsWith('.') && e.name !== '.') {
      if (e.isDirectory()) continue; // .git 等
    }
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, maxFiles, out);
    } else if (e.isFile() && isCodeFile(abs)) {
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      out.push(abs);
    }
  }
}

/**
 * 构造索引器。状态：
 *   fileEntry: Map<abs, {mtimeMs, text, defs}>
 *   symbols:   Map<symbol, {file, line, kind, snippet}>
 *   fileCalls: Map<fromFile, Map<toSymbol, count>>
 */
function createIndexer(opts) {
  const root = path.resolve(opts.root);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const fileEntry = new Map(); // abs -> { mtimeMs, defs, callSites: [{name,line}] }
  const symbols = new Map(); // symbol -> {file,line,kind,snippet}
  const fileCalls = new Map(); // fromFile -> Map<toSymbol, count>（已知符号过滤后）
  let lastIndexedAt = 0;

  function ingest(abs, text, mtimeMs) {
    const defs = scanSource(text);
    const callSites = extractCallSites(text);
    fileEntry.set(abs, { mtimeMs, defs, callSites });
    for (const d of defs) {
      const snippet = text.split('\n').slice(d.line - 1, d.line).join('').trim().slice(0, 200);
      symbols.set(d.symbol, { file: abs, line: d.line, kind: d.kind, snippet });
    }
  }

  function rebuildCalls() {
    // 单遍：每文件的调用点过滤到已知符号（P5 §8 自食发现的 O(文件×符号×行)
    // 二次方炸弹重写——本仓 4000+ 符号曾致单次全量 90s 阻塞主进程 SIGKILL）
    fileCalls.clear();
    for (const [abs, entry] of fileEntry) {
      const ownDefs = new Set(entry.defs.map((d) => d.symbol));
      const calls = new Map();
      for (const site of entry.callSites) {
        if (!symbols.has(site.name)) continue;
        if (ownDefs.has(site.name) && site.line === symbols.get(site.name).line) continue; // 声明行自引用
        calls.set(site.name, (calls.get(site.name) ?? 0) + 1);
      }
      if (calls.size > 0) fileCalls.set(abs, calls);
    }
  }

  function scanFile(abs) {
    const resolved = path.resolve(abs);
    let st, text;
    try {
      st = fs.statSync(resolved);
      text = fs.readFileSync(resolved, 'utf-8');
    } catch {
      // 删除/不可读 → 移出索引
      const old = fileEntry.get(resolved);
      if (old) {
        for (const d of old.defs) {
          const cur = symbols.get(d.symbol);
          if (cur && cur.file === resolved) symbols.delete(d.symbol);
        }
        fileEntry.delete(resolved);
        fileCalls.delete(resolved);
      }
      lastIndexedAt = Date.now();
      return;
    }
    ingest(resolved, text, st.mtimeMs);
    rebuildCalls();
    lastIndexedAt = Date.now();
  }

  function scanFull() {
    const files = [];
    walk(root, maxFiles, files);
    const kept = new Set();
    for (const abs of files) {
      const prev = fileEntry.get(abs);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      kept.add(abs);
      if (prev && prev.mtimeMs === st.mtimeMs) continue; // 未变——复用
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      // 变更文件：先摘旧 defs（符号可能改名/消失）
      if (prev) {
        for (const d of prev.defs) {
          const cur = symbols.get(d.symbol);
          if (cur && cur.file === abs) symbols.delete(d.symbol);
        }
      }
      ingest(abs, text, st.mtimeMs);
    }
    // 消失的文件摘除
    for (const abs of [...fileEntry.keys()]) {
      if (!kept.has(abs)) {
        const old = fileEntry.get(abs);
        for (const d of old.defs) {
          const cur = symbols.get(d.symbol);
          if (cur && cur.file === abs) symbols.delete(d.symbol);
        }
        fileEntry.delete(abs);
      }
    }
    rebuildCalls();
    lastIndexedAt = Date.now();
    return { files: fileEntry.size, symbols: symbols.size, edges: countEdges() };
  }

  function countEdges() {
    let n = 0;
    for (const calls of fileCalls.values()) n += calls.size;
    return n;
  }

  /** 文件→文件邻接（上游：fromFile 调用了 toFile 中的符号） */
  function fileAdjacency() {
    const adj = new Map(); // calleeFile -> Set<callerFile>
    for (const [fromFile, calls] of fileCalls) {
      for (const sym of calls.keys()) {
        const def = symbols.get(sym);
        if (!def || def.file === fromFile) continue;
        if (!adj.has(def.file)) adj.set(def.file, new Set());
        adj.get(def.file).add(fromFile);
      }
    }
    return adj;
  }

  function explore(symbol) {
    if (!symbols.has(symbol)) return null;
    const def = symbols.get(symbol);
    const callers = [];
    for (const [fromFile, entry] of fileEntry) {
      if (fromFile === def.file) continue;
      const lines = entry.callSites.filter((c) => c.name === symbol).map((c) => c.line);
      if (lines.length > 0) callers.push({ file: fromFile, lines });
    }
    // blast radius：从定义文件沿上游邻接传递闭包
    const adj = fileAdjacency();
    const seen = new Set([def.file]);
    const queue = [def.file];
    const blast = new Set();
    while (queue.length > 0) {
      const f = queue.shift();
      for (const caller of adj.get(f) ?? []) {
        if (!seen.has(caller)) {
          seen.add(caller);
          blast.add(caller);
          queue.push(caller);
        }
      }
    }
    blast.delete(def.file);
    return {
      symbol,
      definition: { file: def.file, line: def.line, kind: def.kind, snippet: def.snippet },
      callers,
      blastRadius: [...blast].sort(),
      approximate: true,
    };
  }

  function graph(symbol, limit = 30) {
    const stats = { files: fileEntry.size, symbols: symbols.size, edges: countEdges(), lastIndexedAt };
    const fileNodeId = (absFile) => path.relative(root, path.resolve(absFile));
    if (!symbol || !symbols.has(symbol)) {
      const nodes = [...symbols.entries()].slice(0, limit).map(([id, d]) => ({ id, kind: d.kind }));
      const ids = new Set(nodes.map((n) => n.id));
      const edges = [];
      for (const [fromFile, calls] of fileCalls) {
        for (const sym of calls.keys()) {
          const def = symbols.get(sym);
          if (def && def.file === fromFile) continue;
          const from = fileNodeId(fromFile);
          if (ids.has(sym)) edges.push({ from, to: sym });
        }
      }
      return { nodes, edges: edges.slice(0, limit * 2), stats };
    }
    // 目标邻域：符号 + 其定义文件调出的符号 + 调用它的文件
    const def = symbols.get(symbol);
    const nodes = [{ id: symbol, kind: def.kind }];
    const edges = [];
    for (const [fromFile, calls] of fileCalls) {
      if (calls.has(symbol)) {
        const from = fileNodeId(fromFile);
        nodes.push({ id: from, kind: 'file' });
        edges.push({ from, to: symbol });
      }
    }
    // 定义文件自身的出边（它调了谁）
    const ownCalls = fileCalls.get(def.file);
    if (ownCalls) {
      for (const sym of ownCalls.keys()) {
        if (symbols.has(sym)) {
          nodes.push({ id: sym, kind: symbols.get(sym).kind });
          edges.push({ from: symbol, to: sym });
        }
      }
    }
    const uniq = new Map();
    for (const n of nodes) uniq.set(n.id, n);
    return {
      nodes: [...uniq.values()].slice(0, limit),
      edges: edges.slice(0, limit * 2),
      stats,
    };
  }

  return { scanFull, scanFile, explore, graph };
}

module.exports = { createIndexer };
