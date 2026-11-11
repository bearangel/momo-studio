// electron/tests/files/file-io/file-io-settings.test.ts
import { describe, expect, it } from 'vitest';
import {
  ESAFENET_CLIENT_DIRS,
  detectClientInstalled,
  resolveEffectiveMode,
  resolveFileIoSettings,
  type FileIoConfig,
} from '../../../src/main/files/file-io/file-io-settings';

describe('resolveFileIoSettings', () => {
  it('缺省 direct + strictCipherCheck true + nodePath null', () => {
    expect(resolveFileIoSettings(undefined)).toEqual({
      mode: 'direct',
      nodePath: null,
      strictCipherCheck: true,
    });
  });

  it('非法 mode 回退 direct（EBADMODE 不静默到 auto）', () => {
    // 故意传非法值验证防御（strict 约束下经 unknown 断言，不用 @ts-expect-error）
    const raw = { mode: 'hack' } as unknown as FileIoConfig;
    expect(resolveFileIoSettings(raw).mode).toBe('direct');
  });

  it('显式 proxy / auto 保留；strictCipherCheck 仅显式 false 才关', () => {
    expect(resolveFileIoSettings({ mode: 'proxy' }).mode).toBe('proxy');
    expect(resolveFileIoSettings({ mode: 'auto' }).mode).toBe('auto');
    expect(resolveFileIoSettings({ strictCipherCheck: false }).strictCipherCheck).toBe(false);
  });

  it('空 nodePath 归 null', () => {
    expect(resolveFileIoSettings({ nodePath: '' }).nodePath).toBeNull();
    expect(resolveFileIoSettings({ nodePath: 'C:\\nodejs\\node.exe' }).nodePath).toBe(
      'C:\\nodejs\\node.exe',
    );
  });
});

describe('detectClientInstalled', () => {
  it('任一客户端目录存在即 true', () => {
    const target = ESAFENET_CLIENT_DIRS[0];
    expect(detectClientInstalled((p) => p === target)).toBe(true);
    expect(detectClientInstalled(() => false)).toBe(false);
  });

  it('exists 抛错视为未安装（不崩）', () => {
    expect(
      detectClientInstalled(() => {
        throw new Error('EACCES');
      }),
    ).toBe(false);
  });
});

describe('resolveEffectiveMode', () => {
  it('direct/proxy 原样；auto 按探测结果', () => {
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'direct' }), true)).toBe('direct');
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'proxy' }), false)).toBe('proxy');
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'auto' }), true)).toBe('proxy');
    expect(resolveEffectiveMode(resolveFileIoSettings({ mode: 'auto' }), false)).toBe('direct');
  });
});
