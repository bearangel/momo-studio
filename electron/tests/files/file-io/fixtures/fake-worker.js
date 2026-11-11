// electron/tests/files/file-io/fixtures/fake-worker.js
//
// 与 io-worker 同协议的测试替身（真实子进程 + 真实 stdin/stdout——momo-test-rules
// 保真要求，不用简化 stub）。额外行为（按请求内任一路径的 basename 前缀判定）：
//   hang-now 前缀 → 永不应答（超时测试）
//   die-now 前缀  → 进程立即退出（ECHILD + 自愈测试）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function readOne(p) {
  try {
    const buf = fs.readFileSync(p);
    return { ok: true, dataBase64: buf.toString('base64'), size: buf.length };
  } catch (e) {
    return { ok: false, error: { code: e.code || 'EUNKNOWN', message: e.message } };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  // hang/die 判定须覆盖请求内全部路径：单文件 op 走 req.path，readMany 走 req.paths
  //（主进程 readFile 统一经 readMany 发出——仅查 req.path 会让替身行为永不触发）。
  // 标记按 basename 前缀匹配（hang-now / hang-now.txt 均命中）。
  const reqPaths = [];
  if (typeof req.path === 'string') reqPaths.push(req.path);
  if (Array.isArray(req.paths)) {
    for (const x of req.paths) if (typeof x === 'string') reqPaths.push(x);
  }
  if (reqPaths.some((x) => path.basename(x).startsWith('hang-now'))) return;
  if (reqPaths.some((x) => path.basename(x).startsWith('die-now'))) {
    process.exit(1);
    return;
  }
  const p = typeof req.path === 'string' ? req.path : '';
  let resp;
  try {
    if (req.op === 'read') {
      resp = { id: req.id, ...readOne(p) };
    } else if (req.op === 'readMany') {
      resp = { id: req.id, ok: true, items: req.paths.map(readOne) };
    } else if (req.op === 'write') {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const buf = Buffer.from(req.dataBase64, 'base64');
      fs.writeFileSync(p, buf);
      resp = { id: req.id, ok: true, size: buf.length };
    } else if (req.op === 'stat') {
      resp = { id: req.id, ok: true, size: fs.statSync(p).size };
    } else {
      resp = { id: req.id, ok: false, error: { code: 'EBADREQ', message: 'bad op' } };
    }
  } catch (e) {
    resp = { id: req.id, ok: false, error: { code: e.code || 'EUNKNOWN', message: e.message } };
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
});
rl.on('close', () => process.exit(0));
