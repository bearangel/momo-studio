// electron/tests/workspace/commit-validator.test.ts
//
// 验证 commit message 校验器三模式语义：
//   - strict：命中放行 / 不命中阻断（isCommitBlocked=true）
//   - warning：命中放行 / 不命中也放行（isCommitBlocked=false，但 validateCommitMessage 仍报违规）
//   - none：完全不校验，恒放行
// 另验证：命中后返回 matchedPattern；非法正则 pattern 被跳过而非抛错。

import { describe, it, expect } from 'vitest';
import {
  validateCommitMessage,
  isCommitBlocked,
} from '../../src/main/workspace/commit-validator';
import { defaultGitPolicy, type GitPolicy } from '../../src/main/workspace/git-policy';

function policyWith(level: GitPolicy['commitMessage']['validation']): GitPolicy {
  const p = defaultGitPolicy();
  p.commitMessage.validation = level;
  return p;
}

describe('commit-validator', () => {
  it('strict 模式：命中 S 模式放行并返回 matchedPattern', () => {
    const r = validateCommitMessage('S12345678 用户管理模型', policyWith('strict'));
    expect(r.valid).toBe(true);
    expect(r.matchedPattern?.code).toBe('S');
    expect(isCommitBlocked('S12345678 用户管理模型', policyWith('strict'))).toBe(false);
  });

  it('strict 模式：不命中任一 pattern 则阻断', () => {
    const r = validateCommitMessage('随便写一句', policyWith('strict'));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('期望格式');
    expect(isCommitBlocked('随便写一句', policyWith('strict'))).toBe(true);
  });

  it('strict 模式：命中 conventional commit 也放行', () => {
    expect(validateCommitMessage('feat(git): policy 配置', policyWith('strict')).valid).toBe(true);
  });

  it('warning 模式：不命中时 validateCommitMessage 仍报违规', () => {
    const r = validateCommitMessage('随便写一句', policyWith('warning'));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('期望格式');
  });

  it('warning 模式：isCommitBlocked 永远返回 false（仅告警不阻断）', () => {
    expect(isCommitBlocked('随便写一句', policyWith('warning'))).toBe(false);
    expect(isCommitBlocked('S12345678 好的', policyWith('warning'))).toBe(false);
  });

  it('none 模式：不校验，任何 message 恒放行', () => {
    const r = validateCommitMessage('完全无关的乱码 !!!', policyWith('none'));
    expect(r.valid).toBe(true);
    expect(r.matchedPattern).toBeUndefined();
    expect(isCommitBlocked('完全无关的乱码 !!!', policyWith('none'))).toBe(false);
  });

  it('非法正则 pattern 被跳过而非抛错', () => {
    const p = defaultGitPolicy();
    p.commitMessage.validation = 'strict';
    p.commitMessage.patterns = [
      { code: 'bad', name: '坏正则', regex: '(', example: '(' }, // 非法正则
      { code: 'ok', name: '好的', regex: '^S\\d+', example: 'S1' },
    ];
    // 有一条合法 pattern 能命中，整体放行
    expect(validateCommitMessage('S1 描述', p).valid).toBe(true);
    // 全部非法 / 全不命中时也不抛错
    p.commitMessage.patterns = [{ code: 'bad', name: '坏', regex: '(', example: '(' }];
    const r = validateCommitMessage('S1 描述', p);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('期望格式');
  });

  it('无 pattern 列表的 strict policy：任何 message 都阻断', () => {
    const p = defaultGitPolicy();
    p.commitMessage.validation = 'strict';
    p.commitMessage.patterns = [];
    expect(isCommitBlocked('S1', p)).toBe(true);
  });
});
