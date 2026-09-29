// renderer/src/lib/locate-message.test.ts
//
// 定位链路测试（G2）：分页循环 / 悬空降级 / 非顶层行降级 / 执行会话锚点。
// store 用真实模块 + setState 覆写动作（selectSession/loadOlder 为 spy）；
// DOM 锚点用 jsdom 真实元素；scrollIntoView jsdom 未实现——prototype 桩。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSessionStore } from '../stores/session.store';
import { useUiStore } from '../stores/ui.store';
import { locateMessage, locateTaskExecution, isTopLevelMessage } from './locate-message';
import type { ImMessage } from '../ipc/types';

function makeMsg(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm-1', sessionId: 'ses-1', sender: 'owner', body: '', eventType: 'm.room.message',
    streamSessionId: null, parentStreamSessionId: null, segmentOf: null, segmentIndex: null,
    status: 'done', source: 'local', workspaceId: 'ws-1', taskId: null, contextJson: null,
    createdAt: 1, updatedAt: 1, ...overrides,
  };
}

let anchorEl: HTMLDivElement;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  anchorEl = document.createElement('div');
  anchorEl.id = 'msg-m-1';
  anchorEl.scrollIntoView = scrollIntoView;
  document.body.appendChild(anchorEl);
  // 最小 window.api 桩：session.store 顶层 import ipc client（Proxy 透传），
  // store 动作已被 setState 覆写不会真正触达 IPC——此桩仅保 import 期安全
  (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api = {};
  useUiStore.setState({ setActiveView: vi.fn() } as never);
  // loadOlderError 复位：错误路径用例经 spy 写入后跨用例残留会污染后续循环判定
  useSessionStore.setState({ loadOlderError: null } as never);
});

afterEach(() => {
  anchorEl.remove();
});

describe('locateMessage', () => {
  it('已激活会话 + 消息已加载 → 直接定位（scrollIntoView + flash + 切 im 视图）', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([['ses-1', [makeMsg()]]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateMessage('ses-1', 'm-1');
    expect(r).toBe('located');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(useUiStore.getState().setActiveView).toHaveBeenCalledWith('im');
  });

  it('未激活会话 → 先 selectSession 再定位', async () => {
    useSessionStore.setState({
      activeSessionId: null,
      messagesBySession: new Map([['ses-1', [makeMsg()]]]),
      selectSession: vi.fn().mockImplementation(async () => {
        useSessionStore.setState({ activeSessionId: 'ses-1' } as never);
      }),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateMessage('ses-1', 'm-1');
    expect(r).toBe('located');
    expect(useSessionStore.getState().selectSession).toHaveBeenCalledWith('ses-1');
  });

  it('消息不在已加载窗口 → loadOlder 循环直到命中', async () => {
    let olderLoaded = false;
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([['ses-1', [makeMsg({ id: 'm-new' })]]]),
      hasMoreBySession: new Map([['ses-1', true]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn().mockImplementation(async () => {
        if (olderLoaded) return;
        olderLoaded = true;
        useSessionStore.setState({
          messagesBySession: new Map([['ses-1', [makeMsg(), makeMsg({ id: 'm-new' })]]]),
        } as never);
      }),
    } as never);
    const r = await locateMessage('ses-1', 'm-1');
    expect(r).toBe('located');
    expect(useSessionStore.getState().loadOlder).toHaveBeenCalled();
  });

  it('到底仍未见（悬空 sourceMessageId）→ toast + message-missing（撤回降级路径）', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([['ses-1', [makeMsg({ id: 'm-other' })]]]),
      hasMoreBySession: new Map([['ses-1', false]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateMessage('ses-1', 'm-gone');
    expect(r).toBe('message-missing');
  });

  it('messageId null → 只切会话返回 entered', async () => {
    useSessionStore.setState({
      activeSessionId: null,
      messagesBySession: new Map(),
      // 真实语义对齐：selectSession 成功必写 messagesBySession key（空数组也写），
      // 否则会命中 ensureSession 的吞错 post-check
      selectSession: vi.fn().mockImplementation(async () => {
        useSessionStore.setState({
          activeSessionId: 'ses-1',
          messagesBySession: new Map([['ses-1', []]]),
        } as never);
      }),
      loadOlder: vi.fn(),
    } as never);
    expect(await locateMessage('ses-1', null)).toBe('entered');
  });

  it('selectSession reject → toast 吞错并返回 message-missing', async () => {
    useSessionStore.setState({
      activeSessionId: null,
      messagesBySession: new Map(),
      selectSession: vi.fn().mockRejectedValue(new Error('IPC 断开')),
      loadOlder: vi.fn(),
    } as never);
    expect(await locateMessage('ses-1', 'm-1')).toBe('message-missing');
  });

  it('selectSession 吞错（resolve 但不写 messagesBySession key，生产行为）→ post-check 降级 message-missing，不进翻页循环', async () => {
    const loadOlder = vi.fn();
    useSessionStore.setState({
      activeSessionId: null,
      messagesBySession: new Map(),
      // 模拟真实 selectSession 吞错：getMessages 失败只 set({error})，
      // 不 reject 也不写 messagesBySession key（session.store.ts:257-259）
      selectSession: vi.fn().mockImplementation(async () => {
        useSessionStore.setState({ activeSessionId: 'ses-1' } as never);
      }),
      loadOlder,
      // 显式置 true：防前序用例残留 false 让循环被 hasMore 短路（污染假绿）——
      // post-check 必须在「有更多历史」的前提下仍然拦住
      hasMoreBySession: new Map([['ses-1', true]]),
    } as never);
    expect(await locateMessage('ses-1', 'm-1')).toBe('message-missing');
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('loadOlder 持续失败（store 吞错 set loadOlderError，hasMore 恒 true）→ 本轮即如实中止，不空转 50 批', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([['ses-1', [makeMsg({ id: 'm-other' })]]]),
      hasMoreBySession: new Map([['ses-1', true]]),
      selectSession: vi.fn(),
      // 模拟真实 loadOlder catch 行为：set loadOlderError，不动 hasMoreBySession
      loadOlder: vi.fn().mockImplementation(async () => {
        useSessionStore.setState({ loadOlderError: '加载更早消息失败：boom' } as never);
      }),
    } as never);
    expect(await locateMessage('ses-1', 'm-gone')).toBe('message-missing');
    expect(useSessionStore.getState().loadOlder).toHaveBeenCalledTimes(1);
  });

  it('无进展守卫（空消息列表 + hasMore 恒 true + loadOlder no-op）→ 首轮 break 降级，不自旋', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      // selectSession 成功写入空数组（空会话），loadOlder 空列表守卫即刻 return
      messagesBySession: new Map([['ses-1', []]]),
      hasMoreBySession: new Map([['ses-1', true]]),
      loadOlderError: null,
      selectSession: vi.fn(),
      loadOlder: vi.fn().mockResolvedValue(undefined),
    } as never);
    expect(await locateMessage('ses-1', 'm-gone')).toBe('message-missing');
    expect(useSessionStore.getState().loadOlder).toHaveBeenCalledTimes(1);
  });
});

describe('locateTaskExecution', () => {
  it('锚点 = 已加载消息中 taskId 命中的最后一条顶层消息', async () => {
    document.getElementById('msg-m-t2')?.remove();
    const el2 = document.createElement('div');
    el2.id = 'msg-m-t2';
    el2.scrollIntoView = scrollIntoView;
    document.body.appendChild(el2);
    useSessionStore.setState({
      activeSessionId: 'ses-exec',
      messagesBySession: new Map([
        ['ses-exec', [
          makeMsg({ id: 'm-t1', taskId: 'task-1', sender: 'agent' }),
          makeMsg({ id: 'm-t2', taskId: 'task-1', sender: 'agent' }),
        ]],
      ]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    const r = await locateTaskExecution('task-1', 'ses-exec');
    expect(r).toBe('located');
    expect(scrollIntoView).toHaveBeenCalled();
    el2.remove();
  });

  it('命中行是非顶层（task_reply 被过滤）→ 降级 entered，不 toast 失败', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-exec',
      messagesBySession: new Map([
        ['ses-exec', [makeMsg({ id: 'm-tr', taskId: 'task-1', eventType: 'io.momo-studio.task_reply' })]],
      ]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    expect(await locateTaskExecution('task-1', 'ses-exec')).toBe('entered');
  });

  it('无 taskId 命中 → 只切会话 entered', async () => {
    useSessionStore.setState({
      activeSessionId: 'ses-exec',
      messagesBySession: new Map([['ses-exec', [makeMsg({ id: 'm-x' })]]]),
      selectSession: vi.fn(),
      loadOlder: vi.fn(),
    } as never);
    expect(await locateTaskExecution('task-1', 'ses-exec')).toBe('entered');
  });
});

describe('isTopLevelMessage', () => {
  it('dispatch / task_reply / 嵌套行 / 分段行 → false；普通行 → true', () => {
    expect(isTopLevelMessage(makeMsg())).toBe(true);
    expect(isTopLevelMessage(makeMsg({ eventType: 'io.momo-studio.dispatch' }))).toBe(false);
    expect(isTopLevelMessage(makeMsg({ eventType: 'io.momo-studio.task_reply' }))).toBe(false);
    expect(isTopLevelMessage(makeMsg({ parentStreamSessionId: 's-1' }))).toBe(false);
    expect(isTopLevelMessage(makeMsg({ segmentOf: 'm-0' }))).toBe(false);
  });
});
