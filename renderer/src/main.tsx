// Monaco 配置必须在所有其他 import 之前执行：注入中文 NLS 数据 + 配置 worker + 指向本地包。
import './monaco-setup';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);