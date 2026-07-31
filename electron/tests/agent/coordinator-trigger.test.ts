// electron/tests/agent/coordinator-trigger.test.ts
//
// 协调 agent 触发判定纯函数：三路互斥，不重复响应（详见 v1.1 设计 3.4）。
// 只测 decideResponse 这个纯函数，不依赖 Matrix/LLM/子进程环境。

import { describe, it, expect } from 'vitest';
import { decideResponse } from '../../src/main/agent/runtime-entry';

describe('decideResponse 协调触发判定', () => {
  it('@ 我 → 响应', () => {
    expect(
      decideResponse({
        mentioned: true,
        hasAnyMention: true,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: true,
      }),
    ).toBe('respond');
  });

  it('没 @ + 在团队群 + 我是协调 → 响应', () => {
    expect(
      decideResponse({
        mentioned: false,
        hasAnyMention: false,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: true,
      }),
    ).toBe('respond');
  });

  it('没 @ + 在团队群 + 我不是协调 → 跳过', () => {
    expect(
      decideResponse({
        mentioned: false,
        hasAnyMention: false,
        isTeamRoom: true,
        isCoordinator: false,
        isOwnerMessage: true,
      }),
    ).toBe('skip');
  });

  it('没 @ + 非团队群 + 我是协调 → 跳过（协调只在团队群接待）', () => {
    expect(
      decideResponse({
        mentioned: false,
        hasAnyMention: false,
        isTeamRoom: false,
        isCoordinator: true,
        isOwnerMessage: true,
      }),
    ).toBe('skip');
  });

  it('@ 了别人 + 我是协调 → 跳过（不插嘴）', () => {
    expect(
      decideResponse({
        mentioned: false,
        hasAnyMention: true,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: true,
      }),
    ).toBe('skip');
  });

  it('@ 我 + 非团队群 → 响应（@ 永远优先）', () => {
    expect(
      decideResponse({
        mentioned: true,
        hasAnyMention: true,
        isTeamRoom: false,
        isCoordinator: false,
        isOwnerMessage: true,
      }),
    ).toBe('respond');
  });

  it('没 @ + 团队群 + 我是协调 + 发送者是 owner → 响应', () => {
    expect(
      decideResponse({
        mentioned: false,
        hasAnyMention: false,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: true,
      }),
    ).toBe('respond');
  });

  it('没 @ + 团队群 + 我是协调 + 发送者是 bot（非 owner）→ 跳过（不抢答子 agent 回复）', () => {
    expect(
      decideResponse({
        mentioned: false,
        hasAnyMention: false,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: false,
      }),
    ).toBe('skip');
  });
});
