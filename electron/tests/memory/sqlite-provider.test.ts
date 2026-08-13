// electron/tests/memory/sqlite-provider.test.ts
//
// SQLiteMemoryProvider 单元测试。
// 测试覆盖：
//   - getTaskContext：返回 task + 关键事件（过滤掉 thinking_delta/text_delta）+ 文件产出物
//   - getTaskContext：task 不存在返回 null
//   - getConversationContext：返回最近 N 条消息（升序，bot → assistant / owner → user）
//   - getConversationContext：支持 limit + beforeTs
//   - getAgentContext / getUserContext：v1 stub 返回空对象
//   - getWorkspaceContext：返回基础信息；workspace 不存在返回 null
//
// 测试隔离：每个 case 用独立 tmp 目录 + closeDb + AP_USER_DATA_DIR 重置。
// tasks 表有 FK 到 workspaces(id)，故每个 case 都 seed 一个 ws1。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { insertEvent } from '../../src/main/storage/messages/events-repo';
import { insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { SQLiteMemoryProvider } from '../../src/main/memory/sqlite-provider';

const tmpRoot = path.join(os.tmpdir(), `ap-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, matrix_space_id, owner_id) VALUES (?, ?, ?, ?, ?)`,
  ).run('ws1', 'Test', '/tmp/ws1', '!space:home', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('SQLiteMemoryProvider', () => {
  const provider = new SQLiteMemoryProvider();

  describe('getTaskContext', () => {
    it('返回 task + 关键事件 + 产出物', async () => {
      const task = insertTask({
        workspaceId: 'ws1',
        title: 'T1',
        description: 'do something',
        creatorUserId: '@owner:home',
      });
      transitionTaskStatus(task.id, 'assigned');
      transitionTaskStatus(task.id, 'in_progress', { executionRoomId: 'r1' });

      // task 执行过的事件：thinking_delta + tool_call_start + tool_call_result + final
      const msg = insertMessage({
        roomId: 'r1',
        sender: '@bot:home',
        eventType: 'm.room.message',
        body: '',
        taskId: task.id,
        streamSessionId: 'ss1',
      });
      insertEvent({
        messageId: msg.id,
        seq: 0,
        eventType: 'thinking_delta',
        payload: { delta: 'think' },
      });
      insertEvent({
        messageId: msg.id,
        seq: 1,
        eventType: 'tool_call_start',
        payload: { callId: 'c1', toolName: 'write_file', args: { path: '/a.ts' } },
      });
      insertEvent({
        messageId: msg.id,
        seq: 2,
        eventType: 'tool_call_result',
        payload: { callId: 'c1', result: 'ok', success: true },
      });
      insertEvent({ messageId: msg.id, seq: 3, eventType: 'final', payload: {} });

      const ctx = await provider.getTaskContext(task.id);
      expect(ctx).not.toBeNull();
      expect(ctx!.task.id).toBe(task.id);
      // 关键事件：tool_call_start + tool_call_result + final（不展开 thinking_delta）
      const eventTypes = ctx!.events.map((e) => e.eventType);
      expect(eventTypes).toContain('tool_call_start');
      expect(eventTypes).toContain('tool_call_result');
      expect(eventTypes).toContain('final');
      expect(eventTypes).not.toContain('thinking_delta');
      // 产出物：write_file 类工具
      expect(ctx!.artifacts.length).toBe(1);
      expect(ctx!.artifacts[0]).toMatchObject({
        toolName: 'write_file',
        path: '/a.ts',
        action: 'write',
      });
    });

    it('task 不存在返回 null', async () => {
      expect(await provider.getTaskContext('nonexistent')).toBeNull();
    });
  });

  describe('getConversationContext', () => {
    it('返回最近 N 条消息（按时间升序，user 和 assistant 分开）', async () => {
      const t = Date.now();
      insertMessage({
        roomId: 'r1',
        sender: '@owner:home',
        eventType: 'm.room.message',
        body: 'hi',
        createdAt: t,
      });
      insertMessage({
        roomId: 'r1',
        sender: '@bot:home',
        eventType: 'm.room.message',
        body: 'hello',
        createdAt: t + 1,
      });

      const ctx = await provider.getConversationContext('r1', { limit: 10 });
      expect(ctx.messages.length).toBe(2);
      expect(ctx.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
      expect(ctx.messages[1]).toMatchObject({ role: 'assistant', content: 'hello' });
    });

    it('支持 limit + beforeTs', async () => {
      // insertMessage 内部固定用 Date.now() 作 createdAt，外部传入值被忽略。
      // 用 setTimeout 制造递增时间戳，再读全部找出 m2 时间戳作为 beforeTs 分页点。
      for (let i = 0; i < 5; i++) {
        insertMessage({
          roomId: 'r1',
          sender: '@owner:home',
          eventType: 'm.room.message',
          body: `m${i}`,
        });
        await new Promise((r) => setTimeout(r, 2));
      }
      const all = await provider.getConversationContext('r1', { limit: 10 });
      const msg2Ts = all.messages[2]!.timestamp;
      const ctx = await provider.getConversationContext('r1', {
        limit: 2,
        beforeTs: msg2Ts,
      });
      expect(ctx.messages.length).toBe(2);
      expect(ctx.messages.map((m) => m.content)).toEqual(['m0', 'm1']);
    });
  });

  it('getAgentContext v1 返回 stub 空对象', async () => {
    const ctx = await provider.getAgentContext('@bot:home');
    expect(ctx).toEqual({ preferences: [], learnedPatterns: [] });
  });

  it('getUserContext v1 返回 stub 空对象', async () => {
    const ctx = await provider.getUserContext('@owner:home');
    expect(ctx).toEqual({ preferences: [] });
  });

  it('getWorkspaceContext 返回基础信息', async () => {
    const ctx = await provider.getWorkspaceContext('ws1');
    expect(ctx).toMatchObject({
      workspaceId: 'ws1',
      workspaceName: 'Test',
      directoryPath: '/tmp/ws1',
    });
  });

  it('getWorkspaceContext workspace 不存在返回 null', async () => {
    expect(await provider.getWorkspaceContext('nonexistent')).toBeNull();
  });
});