import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // monaco-editor 0.56 的 exports map 把 'monaco-editor/X' 重映射到 'esm/vs/X.js'，
      // 导致直接 import 'monaco-editor/esm/vs/...' 子路径（含 ?worker）解析失败。
      // 用正则 alias 把 'monaco-editor/esm/vs' 前缀强制指向物理目录，绕过 exports。
      {
        find: /^monaco-editor\/esm\/vs/,
        replacement: path.resolve(__dirname, 'node_modules/monaco-editor/esm/vs'),
      },
    ],
  },
  // monaco-editor 子模块数千个，dev 模式不预构建会导致首次加载极慢（浏览器上千请求）。
  // pre-bundle 成单文件加速。build 阶段由 Rollup 处理，与此无关。
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  server: {
    port: 5173,
  },
});