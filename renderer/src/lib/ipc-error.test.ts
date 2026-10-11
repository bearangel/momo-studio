// renderer/src/lib/ipc-error.test.ts
// ipcErrorMessage 回归锁：剥离 Electron IPC rejection 的 Error 包装文案。
// 真机发现（qa-reports/2026-10-11-file-area-real-acceptance D1）：alert 出现
// 三层前缀——renderer 前缀 + "Error invoking remote method '<channel>': Error: "
// + 主进程原始中文消息。本 util 负责剥中间包装层。
import { describe, it, expect } from 'vitest';
import { ipcErrorMessage } from './ipc-error';

describe('ipcErrorMessage', () => {
  it('剥离标准双层包装（含嵌套 Error: 前缀）——真机 D1 形态', () => {
    const e = new Error(
      "Error invoking remote method 'file:openWithDefaultApp': Error: 外部应用打开失败: Failed to open path",
    );
    expect(ipcErrorMessage(e)).toBe('外部应用打开失败: Failed to open path');
  });

  it('剥离无嵌套 Error: 前缀的形态（部分 Electron 版本/错误类型）', () => {
    const e = new Error("Error invoking remote method 'file:revealInFolder': 路径越界: ../x 不在 workspace 内");
    expect(ipcErrorMessage(e)).toBe('路径越界: ../x 不在 workspace 内');
  });

  it('非 IPC 包装的 message 原样返回（本地错误/裸 throw）', () => {
    expect(ipcErrorMessage(new Error('boom'))).toBe('boom');
    expect(ipcErrorMessage(new Error('Error invoking something else'))).toBe(
      'Error invoking something else',
    );
  });

  it('非 Error 输入走 String()（防御 IPC 边界的任意 rejection 值）', () => {
    expect(ipcErrorMessage('plain string')).toBe('plain string');
    expect(ipcErrorMessage(undefined)).toBe('undefined');
  });

  it('通道名含特殊字符也能匹配（惰性通配，不吞正文）', () => {
    const e = new Error("Error invoking remote method 'a:b-c:d': Error: 中文消息正文");
    expect(ipcErrorMessage(e)).toBe('中文消息正文');
  });
});
