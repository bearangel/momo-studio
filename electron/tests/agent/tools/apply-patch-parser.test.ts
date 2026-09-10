// electron/tests/agent/tools/apply-patch-parser.test.ts
// v2.3 V4A PEG parser corpus 测试：覆盖成功 / 部分失败 / 边界。

import { describe, it, expect } from 'vitest';
import { parsePatch } from '../../../src/main/agent/tools/apply-patch-parser';

describe('parsePatch — add op', () => {
  it('解析单文件 add', () => {
    const patch = `*** Add File: foo.ts
+export const x = 1;
+export const y = 2;
`;
    const ast = parsePatch(patch);
    expect(ast.ops).toHaveLength(1);
    expect(ast.ops[0]).toMatchObject({
      kind: 'add',
      path: 'foo.ts',
      content: 'export const x = 1;\nexport const y = 2;\n',
    });
  });

  it('add 空文件（仅 header）', () => {
    const patch = `*** Add File: empty.ts
`;
    const ast = parsePatch(patch);
    expect(ast.ops[0]?.content).toBe('');
  });

  it('add 多文件', () => {
    const patch = `*** Add File: a.ts
+1
*** Add File: b.ts
+2
`;
    const ast = parsePatch(patch);
    expect(ast.ops).toHaveLength(2);
    expect(ast.ops[0]?.path).toBe('a.ts');
    expect(ast.ops[1]?.path).toBe('b.ts');
  });
});

describe('parsePatch — delete op', () => {
  it('解析单文件 delete', () => {
    const patch = `*** Delete File: old.ts
`;
    const ast = parsePatch(patch);
    expect(ast.ops[0]).toMatchObject({ kind: 'delete', path: 'old.ts' });
  });
});

describe('parsePatch — update op', () => {
  it('解析 update + 单 hunk', () => {
    const patch = `*** Update File: src.ts
@@ const old = 1;
-const old = 1;
+const updated = 1;
`;
    const ast = parsePatch(patch);
    expect(ast.ops[0]?.kind).toBe('update');
    expect(ast.ops[0]?.hunk?.anchor).toBe('const old = 1;');
    expect(ast.ops[0]?.hunk?.changes).toEqual([
      { kind: '-', text: 'const old = 1;' },
      { kind: '+', text: 'const updated = 1;' },
    ]);
  });

  it('update 上下文行（空格前缀）保留', () => {
    const patch = `*** Update File: src.ts
@@ anchor
 context line
-removed
+added
`;
    const ast = parsePatch(patch);
    expect(ast.ops[0]?.hunk?.changes).toEqual([
      { kind: ' ', text: 'context line' },
      { kind: '-', text: 'removed' },
      { kind: '+', text: 'added' },
    ]);
  });
});

describe('parsePatch — 混合多文件', () => {
  it('add + update + delete 三种 op 同 patch', () => {
    const patch = `*** Add File: new.ts
+content
*** Update File: mid.ts
@@ anchor
-old
+new
*** Delete File: old.ts
`;
    const ast = parsePatch(patch);
    expect(ast.ops.map(o => o.kind)).toEqual(['add', 'update', 'delete']);
  });
});

describe('parsePatch — 错误处理', () => {
  it('空 patch 抛错', () => {
    expect(() => parsePatch('')).toThrow();
  });

  it('未知 header 抛错', () => {
    expect(() => parsePatch('*** Unknown: foo\n')).toThrow(/未知.*op/);
  });

  it('update 无 hunk 抛错', () => {
    expect(() => parsePatch('*** Update File: foo.ts\n')).toThrow(/hunk/);
  });

  it('add 行不以 + 开头抛错', () => {
    expect(() => parsePatch('*** Add File: foo.ts\nnot prefixed\n')).toThrow(/^\+/);
  });

  it('update hunk 行不以 - + 空格开头抛错', () => {
    expect(() => parsePatch('*** Update File: foo.ts\n@@ anchor\nbad\n')).toThrow();
  });
});

describe('parsePatch — 路径处理', () => {
  it('trim header 路径', () => {
    const patch = `*** Add File:   spaced.ts
+x
`;
    const ast = parsePatch(patch);
    expect(ast.ops[0]?.path).toBe('spaced.ts');
  });
});
