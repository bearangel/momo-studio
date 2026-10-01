// electron/src/main/lsp/shared-bin.ts
// 面板一键安装的共享目录模块态（D3 修正案）：`<userData>/lsp-bin/`。
// npm install --prefix 落此，findBinaryInPath 探测链追加
// `<sharedDir>/node_modules/.bin`。模块态默认 null 无副作用——registry /
// detect 保持 electron-free 可测；ipc 注册时（registerLspPanelIpc）注入
// `path.join(app.getPath('userData'), 'lsp-bin')`。
let sharedBinDir: string | null = null;

export function setSharedBinDir(dir: string): void {
  sharedBinDir = dir;
}

export function getSharedBinDir(): string | null {
  return sharedBinDir;
}
