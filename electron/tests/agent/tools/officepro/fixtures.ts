// 插件测试共享夹具：PLUGIN_ROOT 定位 + 假 vendor（单测不依赖 npm install）。
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(__dirname, '../../../../..', 'plugins/office-pro');

const FAKE_NPM_LIBS = ['pptxgenjs', 'exceljs', 'docx', 'pdfkit', 'adm-zip'] as const;

/** 造假 vendor：npm 库假包 + momo-libs 假实现（跑 bootstrap/run_js 链路单测用） */
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
