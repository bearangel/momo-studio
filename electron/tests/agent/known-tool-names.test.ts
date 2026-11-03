// 已知工具名集合锁（spec 2026-11-03 §6.3，终审 B2）：插件工具名必须取自
// getDefs() 的真实工具名，而非模块文件名推导——文件名 ≠ 工具名时不得误杀。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAssembledToolDefs = vi.fn();
vi.mock('../../src/main/plugin/tool-catalog', () => ({
  listAssembledToolDefs: (ws: string) => listAssembledToolDefs(ws),
}));

import { collectKnownToolNames } from '../../src/main/agent/known-tool-names';

describe('collectKnownToolNames', () => {
  beforeEach(() => listAssembledToolDefs.mockReset());

  it('内置全集 + 插件真实工具名（文件名 my-tool.js / 工具名 do_thing → 收 do_thing）', () => {
    listAssembledToolDefs.mockReturnValue([
      { pluginId: 'x', pluginName: 'X', toolName: 'do_thing', fullName: 'plugin:x/do_thing', description: '' },
    ]);
    const known = collectKnownToolNames('ws-1');
    expect(known.has('read_file')).toBe(true);
    expect(known.has('plugin:x/do_thing')).toBe(true);
    expect(known.has('plugin:x/my-tool')).toBe(false);
  });

  it('已下线工具不在 known 域（office_create_ppt 会被过滤）', () => {
    listAssembledToolDefs.mockReturnValue([]);
    expect(collectKnownToolNames('ws-1').has('office_create_ppt')).toBe(false);
  });
});
