// 测试夹具（2026-11-03 插件迁出修订）：office-pro 本体已迁独立仓 momo-plugin，
// runtime-wiring（宿主装配锁）不再引用插件目录——载体文件（bootstrap/run.js、
// tools/run_js.js）**冻结副本**落 fixture-files/office-pro/。插件行为本身由
// momo-plugin 仓 tests/officepro/run-js.test.ts 锁住；此处仅需等形载体驱动
// doExecuteTool 装配断言。载体升级随插件大版本变更时人工同步。
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(__dirname, 'fixture-files', 'office-pro');

const FAKE_NPM_LIBS = ['pptxgenjs', 'exceljs', 'docx', 'pdfkit', 'adm-zip'] as const;

/** 造假 vendor：npm 库假包 + momo-libs 假实现（跑 run_js 链路单测用） */
export function makeFakeVendor(root: string): void {
  for (const name of FAKE_NPM_LIBS) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-fake', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { FAKE: '${name}' };\n`);
  }
  for (const name of ['momo-chart', 'momo-pptx-zip', 'momo-validate']) {
    const dir = path.join(root, 'momo-libs', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { FAKE: '${name}' };\n`);
  }
}
