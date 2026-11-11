#!/usr/bin/env node
// scripts/esafenet-probe.mjs
//
// 加密环境冒烟自检（spec §7.3 环境变更清单固化）。职责：
//   1. --self-test       : 无环境依赖的离线自检（魔数判定正确性）
//   2. --file <path>     : 判定目标文件读到的内容是明文还是密文
//   3. --write-probe-dir : 写入探针三段验证（写入 → 非白名单视角读盘字节 → node 侧读回）
//
// 用法示例（研发机）：
//   node scripts/esafenet-probe.mjs --self-test
//   node scripts/esafenet-probe.mjs --file "C:\\repo\\x\\A.java"
//   node scripts/esafenet-probe.mjs --write-probe-dir "C:\\repo\\x"
//
// 判读：--file 输出「密文」= 当前进程不在放行名单（正常——node 一般应为明文）；
//       若 node 也读密文，说明策略/签名校验已变更，Node 代理模式将失效。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const MAGIC = Buffer.from('E-SafeNet', 'latin1');

function looksEncrypted(buf) {
  return Boolean(buf) && buf.length >= 12 && buf.subarray(0, 64).indexOf(MAGIC) !== -1;
}

function selfTest() {
  const cipher = Buffer.from('62142365DA00260100000001452D536166654E65740000004C4F434B', 'hex');
  if (!looksEncrypted(cipher)) throw new Error('self-test 失败：密文样本未命中');
  if (looksEncrypted(Buffer.from('package com.x;\n', 'utf8'))) throw new Error('self-test 失败：明文误报');
  if (looksEncrypted(Buffer.alloc(5))) throw new Error('self-test 失败：过短缓冲应返回 false');
  console.log('[ok] self-test 通过');
}

function probeFile(p) {
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${p}`);
  const buf = fs.readFileSync(p);
  const verdict = looksEncrypted(buf) ? '密文' : '明文';
  console.log(`[${verdict}] ${p}（${buf.length} 字节）`);
  if (verdict === '密文') {
    console.log('  提示：本进程不在放行名单内。Node 代理模式依赖 node 是放行进程——');
    console.log('        若本脚本以 node 运行仍读到密文，代理模式将不可用（策略或签名校验已变更）。');
  } else {
    const head = buf.subarray(0, 80).toString('utf8').split('\n')[0];
    console.log(`  首行预览: ${JSON.stringify(head)}`);
  }
  return verdict;
}

/** 用非白名单进程视角读取磁盘原始字节（Windows 用 PowerShell；其它平台直接读盘） */
function readRawViaUnlistedProcess(p) {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${p.replace(/'/g, "''")}'))`],
      { encoding: 'utf8', timeout: 20000 },
    );
    return Buffer.from(out.trim(), 'base64');
  }
  return fs.readFileSync(p);
}

function writeProbe(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const probePath = path.join(dir, `.momo-esafenet-probe-${process.pid}.java`);
  const payload = `public class MomoProbe { /* ${new Date().toISOString()} */ }\n`;
  fs.writeFileSync(probePath, payload);

  const backViaNode = fs.readFileSync(probePath, 'utf8');
  const nodeRoundtripOk = backViaNode === payload;

  let rawCipher;
  try {
    rawCipher = looksEncrypted(readRawViaUnlistedProcess(probePath));
  } catch (e) {
    console.warn(`[warn] 非放行进程视角读取失败（${e.message}）——跳过该段检查`);
    rawCipher = null;
  }

  console.log(`[write-probe] 探针文件: ${probePath}`);
  console.log(`  node 侧写→读一致: ${nodeRoundtripOk ? 'PASS' : 'FAIL'}`);
  if (rawCipher === null) {
    console.log('  非放行进程视角: SKIP（无法读取——请人工用 IDE 打开探针文件确认）');
  } else {
    console.log(`  磁盘原始字节为密文形态: ${rawCipher ? 'PASS' : 'FAIL'}`);
    if (!rawCipher) {
      console.log('  ⚠ 落盘为明文——当前环境可能未启用代理写入要求，或写入走了非放行进程。');
    }
  }

  fs.rmSync(probePath, { force: true });
  console.log('  已清理探针文件');
  return nodeRoundtripOk && rawCipher !== false;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    return;
  }
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0 && args[fileIdx + 1]) {
    probeFile(args[fileIdx + 1]);
    return;
  }
  const dirIdx = args.indexOf('--write-probe-dir');
  if (dirIdx >= 0 && args[dirIdx + 1]) {
    const ok = writeProbe(args[dirIdx + 1]);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  console.log('用法:');
  console.log('  node scripts/esafenet-probe.mjs --self-test');
  console.log('  node scripts/esafenet-probe.mjs --file <受控文件路径>');
  console.log('  node scripts/esafenet-probe.mjs --write-probe-dir <受控目录>');
}

main();
