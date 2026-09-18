// 空壳：canvas 替身。pdfjs-dist 文本提取路径不触渲染，无需真实 node-canvas。
// 本任务前 canvas 从未在依赖树中且全套件绿——替身零行为风险（见 task-3-report Fix wave 3）。
module.exports = {};
