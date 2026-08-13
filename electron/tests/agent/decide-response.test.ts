// electron/tests/agent/decide-response.test.ts
//
// decideResponse 三种会话场景路由测试（B 子系统 v2 更新）。
// 覆盖：
//   场景 1.3：单聊（user + 1 agent）—— 无需 @
//   场景 1.1：被 @ 直接响应；群组有 PM agent + 我是协调 + owner 发 + 无 @ 自动接待
//   场景 1.2：群组无 PM agent + 未 @ → 不响应
//
// 取代旧 coordinator-trigger.test.ts（旧版 5 参数签名，本版加 isDirectChat + hasCoordinator）。
// 详见 docs/plans/2026-08-13-platform-redesign-b-task-model.md Task B6。

import { describe, it, expect } from 'vitest';
import { decideResponse } from '../../src/main/agent/decide-response';

/** 基线参数：所有场景的"安全默认"——非单聊 / 非 @ / 非团队群 / 非协调 / owner 发 / 无协调 agent */
const base = {
  mentioned: false,
  hasAnyMention: false,
  isTeamRoom: false,
  isCoordinator: false,
  isOwnerMessage: true,
  isDirectChat: false,
  hasCoordinator: false,
};

describe('decideResponse（B 子系统更新）', () => {
  it('场景 1.3：单聊（user + 1 agent）—— 无需 @', () => {
    expect(decideResponse({ ...base, mentioned: false, isDirectChat: true })).toBe('respond');
  });

  it('场景 1.1：被 @ 直接响应', () => {
    expect(decideResponse({ ...base, mentioned: true })).toBe('respond');
  });

  it('场景 1.1：群组有协调 agent + 我是协调 + owner 发 + 无任何 @ → 自动接待', () => {
    expect(
      decideResponse({
        ...base,
        mentioned: false,
        hasAnyMention: false,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: true,
        hasCoordinator: true,
      }),
    ).toBe('respond');
  });

  it('场景 1.2：群组无 PM agent，未 @ → 不响应', () => {
    expect(
      decideResponse({
        ...base,
        mentioned: false,
        isTeamRoom: true,
        hasCoordinator: false,
      }),
    ).toBe('skip');
  });

  it('群组有 PM 但我不是协调 agent → 不响应（让协调接待）', () => {
    expect(
      decideResponse({
        ...base,
        mentioned: false,
        isTeamRoom: true,
        isCoordinator: false,
        hasCoordinator: true,
      }),
    ).toBe('skip');
  });

  it('群组有 PM + 我是协调 + 非 owner 发 → 不响应（防外部渗透）', () => {
    expect(
      decideResponse({
        ...base,
        mentioned: false,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: false,
        hasCoordinator: true,
      }),
    ).toBe('skip');
  });

  it('群组有 PM + 我是协调 + owner 发 + 有其他 @ → 不响应（让别人答）', () => {
    expect(
      decideResponse({
        ...base,
        mentioned: false,
        hasAnyMention: true,
        isTeamRoom: true,
        isCoordinator: true,
        isOwnerMessage: true,
        hasCoordinator: true,
      }),
    ).toBe('skip');
  });

  it('单聊优先级最高（即使 hasAnyMention=true）', () => {
    expect(
      decideResponse({
        ...base,
        mentioned: false,
        hasAnyMention: true,
        isDirectChat: true,
      }),
    ).toBe('respond');
  });
});
