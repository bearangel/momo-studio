// 测试夹具加载器（spec 2026-11-03 §6 下线后）：pptxgenjs / docx / pdfkit 三库
// 已从 electron 运行依赖移除。2026-11-03 插件迁出修订：office-pro 已迁独立仓
// momo-plugin，宿主测试不再跨仓引用插件 vendor——三库改挂 devDependencies，
// 经本包 node_modules 裸 require 解析（自包含，CI 无需 sibling 插件仓）。
// 旧版 ENTRY 表（pdfkit 无 main 需指到文件）随 exports map 时代退役——三库
// 现行版本 exports 均定义 '.' 入口。
export function loadVendorLib<T = unknown>(name: 'pptxgenjs' | 'docx' | 'pdfkit'): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(name) as T;
}
