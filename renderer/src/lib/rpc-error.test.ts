// renderer/src/lib/rpc-error.test.ts
//
// M4.1 错误契约 renderer 侧单源解析单测：`[code] message` 前缀（主进程 coded
// 产出）命中/不命中全矩阵 + 展示文案剥前缀；双侧等值锁在 electron 侧
// （tests/hub/ipc.test.ts，fixture 共用 RPC_ERROR_ROUNDTRIP_FIXTURES）。
import { describe, expect, it } from 'vitest';
import { parseRpcErrorCode, rpcErrorMessage, RPC_ERROR_ROUNDTRIP_FIXTURES } from './rpc-error';

describe('parseRpcErrorCode（前缀解析）', () => {
  it('命中：Error message 带 [code] 前缀 → {code, 剥前缀原文}', () => {
    expect(parseRpcErrorCode(new Error('[node_offline] 目标节点不在线')))
      .toEqual({ code: 'node_offline', message: '目标节点不在线' });
    expect(parseRpcErrorCode(new Error('[not_waiting] 任务当前状态为 running，非等待态不可代答')))
      .toEqual({ code: 'not_waiting', message: '任务当前状态为 running，非等待态不可代答' });
  });

  it('命中：非 Error rejection（字符串）同样解析；多行 message 保留', () => {
    expect(parseRpcErrorCode('[conflict] 第一行\n第二行')).toEqual({ code: 'conflict', message: '第一行\n第二行' });
  });

  it('不命中：无前缀 / 前缀不在句首 / code 含大写或数字 / 空括号 → null（本地错误与旧 hub 原文）', () => {
    expect(parseRpcErrorCode(new Error('hub 未连接，请稍后重试'))).toBeNull();
    expect(parseRpcErrorCode(new Error('前置 [node_offline] 非句首'))).toBeNull();
    expect(parseRpcErrorCode(new Error('[NodeOffline] 大写'))).toBeNull();
    expect(parseRpcErrorCode(new Error('[node_offline2] 含数字'))).toBeNull();
    expect(parseRpcErrorCode(new Error('[] 空码'))).toBeNull();
    expect(parseRpcErrorCode(new Error('[node_offline]'))).toBeNull(); // 码后缺空格+正文
  });

  it('双侧 fixture 自洽：每条 `[code] message` 均可解析回逐字段等值', () => {
    for (const { code, message } of RPC_ERROR_ROUNDTRIP_FIXTURES) {
      expect(parseRpcErrorCode(new Error(`[${code}] ${message}`))).toEqual({ code, message });
    }
  });
});

describe('rpcErrorMessage（展示文案）', () => {
  it('带前缀 → 剥前缀回原文（前缀是传输编码非用户可读）', () => {
    expect(rpcErrorMessage(new Error('[forbidden] 仅组长（leader）可执行该操作')))
      .toBe('仅组长（leader）可执行该操作');
  });

  it('无前缀 Error → message 原样；非 Error → String() 兜底', () => {
    expect(rpcErrorMessage(new Error('本地人话错误'))).toBe('本地人话错误');
    expect(rpcErrorMessage('裸字符串')).toBe('裸字符串');
  });
});
