#!/usr/bin/env node
// plugins/codegraph/bin/boot.js
//
// 引擎整合（spec §7 首启时序 + 终审 C1/I5 修复）：
//   - serve 先行：立即 exec serve --mcp（initialize 握手秒回，不受建图时长影响）
//   - init 并行：无索引时后台 init -y（引擎 FileLock 管并发；期间 explore 返回
//     引擎级「未建图」提示，init 完成后自动命中——动态查找语义）
//   - 进程链卫生（C1）：stdin 经管道转发给 engine（EOF 感知可靠），宿主断连
//     （SIGTERM/管道关闭）联动杀 engine，杜绝孙进程孤儿泄漏；error 兜底退出。
// mcp.json 模板展开传入：--engine <engineBin> --root <workspaceRoot>；
// 运行时解释器：引擎自带 Node（${engineNode}）或宿主 node（dev）。
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const engine = argOf('--engine');
const root = argOf('--root');
if (!engine || !root) {
  process.stderr.write('boot.js 需要 --engine <engineBin> --root <workspaceRoot>\n');
  process.exit(2);
}

const codegraphDir = process.env.CODEGRAPH_DIR || '.codegraph';
const indexDir = path.join(root, codegraphDir);
const needInit = !fs.existsSync(indexDir);

// stdout/stderr 直通宿主管道；stdin 由本进程转发（EOF 感知 + 数据不抢读）
const child = spawn(engine, ['serve', '--mcp', '--path', root], {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: process.env,
});

child.on('error', (err) => {
  process.stderr.write(`引擎启动失败: ${err.message}\n`);
  process.exit(3);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

function killEngine() {
  try { child.kill('SIGTERM'); } catch { /* 已退 */ }
}
// 宿主断连三通道：信号 / stdin EOF（管道转发下可靠）/ 兜底
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, killEngine);
}
process.stdin.on('end', killEngine);
process.stdin.on('error', () => undefined);
process.stdin.resume();
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => undefined); // engine 先退时管道破裂忽略

// 首启建图与 serve 并行（I5：不再阻塞握手）
if (needInit) {
  const initChild = spawn(engine, ['init', root, '-y'], { stdio: 'ignore', env: process.env });
  initChild.on('error', () => undefined); // init 失败交由 serve 面暴露
}
