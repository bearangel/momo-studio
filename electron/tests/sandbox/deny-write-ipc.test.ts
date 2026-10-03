// electron/tests/sandbox/deny-write-ipc.test.ts
// sandbox:denyWrite 载荷处理（spec hard-gate §4.3）：逐字段校验 + 广播转发。
// 纯函数直测（ipcMain 注册壳不进单测——electron 模块依赖）。
import { describe, it, expect, vi } from 'vitest';
import { handleDenyWrite } from '../../src/main/sandbox/ipc.handlers';

describe('handleDenyWrite（spec §4.3）', () => {
  it('合法载荷 → 广播原样转发（dirs 透传，sessionId 仅日志用途不进广播）', () => {
    const broadcast = vi.fn();
    handleDenyWrite({ sessionId: 's-1', dirs: ['/a', '/b'] }, broadcast);
    expect(broadcast).toHaveBeenCalledWith(['/a', '/b']);
  });

  it('sessionId=null 合法（卡事件解析失败降级形态）', () => {
    const broadcast = vi.fn();
    expect(() => handleDenyWrite({ sessionId: null, dirs: [] }, broadcast)).not.toThrow();
    expect(broadcast).toHaveBeenCalledWith([]);
  });

  it('dirs 非数组 / 含非字符串 → 抛中文错误（防串写，照 grantWrite 校验风格）', () => {
    const broadcast = vi.fn();
    expect(() => handleDenyWrite({ sessionId: 's', dirs: 42 }, broadcast)).toThrow('dirs 非法');
    expect(() => handleDenyWrite({ sessionId: 's', dirs: ['/a', 7] }, broadcast)).toThrow('dirs 非法');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sessionId 非法类型（非 string 非 null）→ 抛错', () => {
    expect(() => handleDenyWrite({ sessionId: 42, dirs: [] }, vi.fn())).toThrow('sessionId 非法');
  });
});
