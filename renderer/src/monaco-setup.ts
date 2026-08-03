// renderer/src/monaco-setup.ts
// Monaco 编辑器初始化配置：本地 npm 包加载（离线优先）+ 中文 locale + worker 走 Vite 打包。
//
// 必须在 main.tsx 顶部、任何 <Editor /> 渲染前 import，确保 globalThis 在 monaco-editor
// 主模块初始化前就被注入中文 NLS 数据。
//
// 中文化原理：monaco-editor 0.50+ 把 nls 从 path-based 改为 index-based，
// 内部调用 localize(849, "Cu&&t") 时通过 globalThis._VSCODE_NLS_MESSAGES[index] 查翻译。
// 官方在 esm/vs/nls/lang/ 下提供各语言预生成文件（含 zh-cn.js），import 该文件即可设置 globalThis。

// loader 来自 @monaco-editor/react，用于把 <Editor /> 的 monaco 实例指向本地包
import { loader } from '@monaco-editor/react';

// 1) 中文 locale：必须在 monaco-editor 主模块之前 import。
//    该 side-effect 模块会设置 globalThis._VSCODE_NLS_MESSAGES（中文消息数组）+ _VSCODE_NLS_LANGUAGE。
//    路径走物理路径（esm/vs/...），由 vite.config.ts 的正则 alias 绕过 exports 限制。
import 'monaco-editor/esm/vs/nls/lang/zh-cn';

// 2) 本地 monaco-editor 包（替代 @monaco-editor/react 默认的 CDN 加载，实现离线优先）。
//    主入口走 exports 的 '.' 映射，不受 alias 影响。
import * as monaco from 'monaco-editor';

// 3) 各语言 worker：用 Vite 的 ?worker 后缀打成独立 chunk，Monaco 在独立线程跑语言服务。
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// 配置 Monaco worker 工厂：Monaco 通过 MonacoEnvironment.getWorker(label) 拿到对应语言的 worker 实例。
// label 由 Monaco 内部按当前 model 的语言决定。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// 让 @monaco-editor/react 使用本地打包的 monaco 实例，而非从 jsdelivr CDN 拉取。
loader.config({ monaco });
