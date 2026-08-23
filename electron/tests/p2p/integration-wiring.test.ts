// electron/tests/p2p/integration-wiring.test.ts
//
// P2P 子系统集成接线测试（I2 修复）：
//   - handleRemoteMessage：远端 message → insertMessage(source='lan') → push 到 renderer
//   - broadcastLocalMessage：本地新消息 → 委托模块级 sync.broadcastNewMessage
//
// 设计说明：
//   - insertMessage 用 vi.mock 替换整个 messages/repo 模块
//   - BrowserWindow.getAllWindows 用 vi.mock 替换 electron 模块
//   - 不依赖真实 DB / 网络 / 文件 IO
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted 保证 mock 引用在 vi.mock factory（会被提升到文件顶部）执行时已初始化
const { mockInsertMessage, mockWebContentsSend } = vi.hoisted(() => ({
  mockInsertMessage: vi.fn(),
  mockWebContentsSend: vi.fn(),
}));

vi.mock('../../src/main/storage/messages/repo', () => ({
  insertMessage: mockInsertMessage,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: mockWebContentsSend },
      },
    ],
  },
  ipcMain: { handle: vi.fn() },
}));

import { handleRemoteMessage, broadcastLocalMessage } from '../../src/main/p2p/index';
import type { SyncMessage } from '../../src/main/p2p/sync';

describe('P2P 集成接线（I2）', () => {
  beforeEach(() => {
    mockInsertMessage.mockReset();
    mockWebContentsSend.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleRemoteMessage', () => {
    it('远端 message → insertMessage(source=lan) + push im:message 到 renderer', () => {
      const inserted = {
        id: 'msg-1',
        sessionId: '!room1:home',
        sender: '@peer:home',
        body: 'hello',
        eventType: 'm.room.message',
      };
      mockInsertMessage.mockReturnValue(inserted);

      const msg: SyncMessage = {
        roomId: '!room1:home',
        sender: '@peer:home',
        body: 'hello',
        eventType: 'm.room.message',
      };
      handleRemoteMessage(msg);

      // 验证 insertMessage 被调用，source='lan'（标识跨节点来源）
      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: '!room1:home',
          sender: '@peer:home',
          body: 'hello',
          eventType: 'm.room.message',
          source: 'lan',
        }),
      );

      // 验证推送到 renderer
      expect(mockWebContentsSend).toHaveBeenCalledTimes(1);
      expect(mockWebContentsSend).toHaveBeenCalledWith('im:message', inserted);
    });

    it('hub 来源的 message 也走同一路径（source=lan 是 P2P 统一标识）', () => {
      mockInsertMessage.mockReturnValue({ id: 'msg-2' });

      handleRemoteMessage({
        roomId: '!room2:home',
        sender: '@remote-hub:home',
        body: 'via hub',
        eventType: 'm.room.message',
      });

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'lan' }),
      );
    });

    it('insertMessage 抛错时不 crash（catch 记录日志，不 push）', () => {
      mockInsertMessage.mockImplementation(() => {
        throw new Error('DB locked');
      });

      // 不应抛出——handleRemoteMessage 内部 catch
      expect(() =>
        handleRemoteMessage({
          roomId: '!r:home',
          sender: '@p:home',
          body: 'x',
          eventType: 'm.room.message',
        }),
      ).not.toThrow();

      // insertMessage 失败 → 不应 push
      expect(mockWebContentsSend).not.toHaveBeenCalled();
    });
  });

  describe('broadcastLocalMessage', () => {
    it('sync 未初始化时 no-op（不抛错）', async () => {
      // broadcastLocalMessage 在 sync=null 时静默返回（P2P 未启用）
      await expect(
        broadcastLocalMessage({
          roomId: '!r:home',
          sender: '@me:home',
          body: 'hi',
          eventType: 'm.room.message',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
