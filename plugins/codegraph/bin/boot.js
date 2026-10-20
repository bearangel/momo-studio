#!/usr/bin/env node
// plugins/codegraph/bin/boot.js
//
// 引擎整合 T8（spec §7 首启时序补充）：codegraph serve 只加载已有索引，
// 不建图——本 wrapper 首启探测 <root>/<CODEGRAPH_DIR> 不存在时先 `init -y`
// 建图（一次性，stdio 静默），再 exec serve --mcp。跨平台（宿主 Node 运行，
// 无 shell 依赖）。mcp.json 经模板展开传入：--engine <engineBin> --root <workspaceRoot>。
'use strict';
const { spawn, spawnSync } = require('node:child_process');
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
if (!fs.existsSync(indexDir)) {
  // 首启建图：同步等待完成（serve 在此之前无索引可服务）；失败不阻断——
  // serve 仍启动，工具调用面报引擎级错误（可观察）
  try {
    spawnSync(engine, ['init', root, '-y'], { stdio: 'ignore', env: process.env });
  } catch {
    // init 失败交由 serve 暴露真实错误
  }
}

const child = spawn(engine, ['serve', '--mcp', '--path', root], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: process.env,
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
