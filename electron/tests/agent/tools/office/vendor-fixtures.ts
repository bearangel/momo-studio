// 测试夹具加载器（spec 2026-11-03 §6 下线后）：pptxgenjs / docx / pdfkit 三库
// 已从 electron 依赖移除，测试改为从 office-pro 插件 vendor 加载（仅造夹具用）。
import path from 'node:path';

const VENDOR = path.resolve(__dirname, '../../../../../plugins/office-pro/vendor/node_modules');

/** vendor 目录内库入口：pdfkit 无 main 字段（仅 exports），绝对路径 require 需指到文件 */
const ENTRY: Record<'pptxgenjs' | 'docx' | 'pdfkit', string> = {
  pptxgenjs: '',
  docx: '',
  pdfkit: 'js/pdfkit.js',
};

export function loadVendorLib<T = unknown>(name: 'pptxgenjs' | 'docx' | 'pdfkit'): T {
  const entry = ENTRY[name];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(VENDOR, name, entry)) as T;
}
