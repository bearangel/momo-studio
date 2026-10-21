// renderer/src/lib/capability-helpers.test.ts
// 插件工具授权模型纯函数（spec 2026-10-21 §6：勾=授权，默认关——翻转旧 denied 模型）
import { describe, it, expect } from 'vitest';
import { effectivePluginGranted, computePluginToolGrants } from './capability-helpers';


describe('插件工具授权模型（spec 2026-10-21 §6：勾=授权，默认关）', () => {
  it('effectivePluginGranted：(ws授权 ∪ added) − (removed ∪ def禁)；组模式串命中', () => {
    const out = effectivePluginGranted(
      ['plugin:p/x'],
      { addedPluginTools: ['plugin:p/y', 'plugin:q/*'], removedPluginTools: ['plugin:q/a'] },
      ['plugin:p/z', 'plugin:p/x'],
      ['plugin:p/x', 'plugin:p/y', 'plugin:p/z', 'plugin:q/a', 'plugin:q/b'],
    );
    // p/x def禁剔；p/y added 留；p/z ws授权留；q/a 精确removed剔；q/b 组授权added留
    expect(new Set(out)).toEqual(new Set(['plugin:p/z', 'plugin:p/y', 'plugin:q/b']));
  });

  it('computePluginToolGrants：勾 → added 授权行（并清 removed）；取消 → removed 行（并清 added）', () => {
    const on = computePluginToolGrants(
      [],
      { addedPluginTools: [], removedPluginTools: ['plugin:p/a'] },
      'plugin:p/a',
      true,
    );
    expect(on).toEqual({ addedPluginTools: ['plugin:p/a'], removedPluginTools: [] });
    const off = computePluginToolGrants(
      [],
      { addedPluginTools: ['plugin:p/a'], removedPluginTools: [] },
      'plugin:p/a',
      false,
    );
    expect(off).toEqual({ addedPluginTools: [], removedPluginTools: ['plugin:p/a'] });
  });

  it('组模式授权串可入 added 行（electron toolRefMatches 命中本插件全部）', () => {
    const g = computePluginToolGrants([], { addedPluginTools: [], removedPluginTools: [] }, 'plugin:p/*', true);
    expect(g.addedPluginTools).toEqual(['plugin:p/*']);
  });
});
