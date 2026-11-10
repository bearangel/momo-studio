// electron/tests/ipc/preload-oauth-channel-contract.test.ts
//
// 契约锁：oauth:* 通道在 main handler 与 preload 两侧必须一一对应。
// 与 preload-hub-channel-contract 同手法（源码文本机械比对，无需起 Electron）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf-8');
}

function extractChannels(source: string): string[] {
  const matches = source.match(/'oauth:[A-Za-z]+'/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))].sort();
}

describe('oauth 通道契约', () => {
  it('main handler 与 preload 两侧通道集完全一致', () => {
    const main = extractChannels(read('electron/src/main/oauth/ipc.handlers.ts'));
    const preload = extractChannels(read('electron/src/preload/index.ts'));
    expect(main.length).toBeGreaterThan(0);
    expect(preload).toEqual(main);
  });

  it('renderer 类型面声明了 oauth 命名空间', () => {
    const types = read('renderer/src/ipc/types.d.ts');
    expect(types).toContain('OAuthApiSurface');
    expect(types).toContain('oauth: OAuthApiSurface');
  });
});
