// electron/tests/agent/message-target-resolver.test.ts
//
// resolveMessageTarget 单元测试——task-driven 模式下 m.room.message 的目标 agent 解析。
// 纯函数测试：不依赖 Matrix client / DB，所有上下文由参数注入。
//
// 覆盖 decideResponse 的三种场景：
//   1.3 单聊：room 仅 owner + 1 agent → 自动响应
//   1.1 @ 直接响应 / 群组 PM 自动接待
//   1.2 群组无 PM / 未 @ → 不响应
import { describe, it, expect } from 'vitest';
import { resolveMessageTarget, type BotCandidate, type WorkspaceInfo } from '../../src/main/agent/message-target-resolver';

const ws: WorkspaceInfo = {
  ownerId: '@owner:home',
  teamSessionId: '!team:home',
  hasCoordinator: true,
};

const pm: BotCandidate = {
  botUserId: '@pm:home',
  assignmentId: 'inst-pm',
  workspaceId: 'ws1',
  isCoordinator: true,
};

const sub: BotCandidate = {
  botUserId: '@sub:home',
  assignmentId: 'inst-sub',
  workspaceId: 'ws1',
  isCoordinator: false,
};

describe('resolveMessageTarget', () => {
  describe('场景 1.3：单聊自动响应', () => {
    it('isDirectChat=true → 返回唯一的 bot candidate', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!dm:home',
          content: { body: '你好' },
          isDirectChat: true,
          candidates: [pm],
        },
        ws,
      );
      expect(target).toBe('inst-pm');
    });

    it('isDirectChat=true 且无 @ 也响应', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!dm:home',
          content: { body: '没有 mention 的消息' },
          isDirectChat: true,
          candidates: [pm],
        },
        ws,
      );
      expect(target).toBe('inst-pm');
    });
  });

  describe('场景 1.1：@ 直接响应', () => {
    it('m.mentions 包含 bot → 该 bot 响应', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: {
            body: '@pm 帮我做事',
            'm.mentions': { user_ids: ['@pm:home'] },
          },
          isDirectChat: false,
          candidates: [pm, sub],
        },
        ws,
      );
      expect(target).toBe('inst-pm');
    });

    it('m.mentions 包含 sub → sub 响应（不是 PM）', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: {
            body: '@sub 你来',
            'm.mentions': { user_ids: ['@sub:home'] },
          },
          isDirectChat: false,
          candidates: [pm, sub],
        },
        ws,
      );
      expect(target).toBe('inst-sub');
    });

    it('群组 PM 自动接待：team room + owner 发 + 无 @ + 有 coordinator', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: { body: '所有人来做事' },
          isDirectChat: false,
          candidates: [pm, sub],
        },
        ws,
      );
      // PM isCoordinator=true → 自动接待；sub isCoordinator=false → skip
      expect(target).toBe('inst-pm');
    });
  });

  describe('场景 1.2：不响应', () => {
    it('群组无 coordinator → 未 @ 不响应', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: { body: '没人 @ 我就不理' },
          isDirectChat: false,
          candidates: [sub], // sub 不是 coordinator
        },
        ws,
      );
      expect(target).toBeNull();
    });

    it('群组 hasCoordinator=false → 未 @ 不响应', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: { body: '没 PM 的群' },
          isDirectChat: false,
          candidates: [pm],
        },
        { ...ws, hasCoordinator: false },
      );
      expect(target).toBeNull();
    });

    it('非 owner 发消息且未 @ → 不响应', () => {
      const target = resolveMessageTarget(
        {
          sender: '@stranger:home',
          roomId: '!team:home',
          content: { body: '外人发消息' },
          isDirectChat: false,
          candidates: [pm],
        },
        ws,
      );
      expect(target).toBeNull();
    });

    it('非 team room 且未 @ 且非单聊 → 不响应', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!other:home',
          content: { body: '普通群消息' },
          isDirectChat: false,
          candidates: [pm],
        },
        ws,
      );
      expect(target).toBeNull();
    });

    it('无 candidate → null', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: { body: '无 agent 在此 room' },
          isDirectChat: false,
          candidates: [],
        },
        ws,
      );
      expect(target).toBeNull();
    });
  });

  describe('m.mentions 边界', () => {
    it('m.mentions 为空对象 → hasAnyMention=false', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: { body: 'hi', 'm.mentions': {} },
          isDirectChat: false,
          candidates: [pm],
        },
        ws,
      );
      // 有 coordinator + PM + owner + 无 mention → 自动接待
      expect(target).toBe('inst-pm');
    });

    it('@ 别人（非 candidate bot）→ hasAnyMention=true，PM 不自动接待', () => {
      const target = resolveMessageTarget(
        {
          sender: '@owner:home',
          roomId: '!team:home',
          content: {
            body: '@other 消息',
            'm.mentions': { user_ids: ['@other:home'] },
          },
          isDirectChat: false,
          candidates: [pm],
        },
        ws,
      );
      // hasAnyMention=true → PM 自动接待条件不满足；mentioned=false → 不响应
      expect(target).toBeNull();
    });
  });
});
