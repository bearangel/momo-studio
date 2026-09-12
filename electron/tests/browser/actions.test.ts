// electron/tests/browser/actions.test.ts
//
// 输入动作层测试——spy webContents 仿真真实运行时语义（momo-test-rules）：
//   1. executeJavaScript 返回真实页内脚本的输出形态——JSON 字符串（buildResolveScript
//      尾部 JSON.stringify；Electron 经 V8 context bridge 序列化回传字符串）
//   2. sendInputEvent 事件类型名对齐 electron.d.ts MouseInputEvent/KeyInputEvent 联合：
//      brief 中 mousePressed/mouseReleased/mouseMoved 为 CDP 名称，经 sendInputEvent
//      对应 Electron 的 mouseDown/mouseUp/mouseMove（写错类型名真实运行时不被接受）
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ManagedWebContents } from '../../src/main/browser/manager';
import {
  clickElement,
  hoverElement,
  pressKey,
  resolveElement,
  scrollWheel,
  typeText,
} from '../../src/main/browser/actions';
import { BrowserInvalidKeyError, BrowserSelectorError } from '../../src/main/browser/errors';

// =================================================================================
// spy webContents（结构性满足 ManagedWebContents；仅 executeJavaScript /
// sendInputEvent 有行为，其余 vi.fn 占位——mock 收窄在 Electron 边界）
// =================================================================================

/** 命中矩形：中心 (125, 210) */
const HIT_RECT = { x: 100, y: 200, width: 50, height: 20, description: 'button "Go"' };

function hitJson(): string {
  return JSON.stringify({ rect: { ...HIT_RECT }, hints: [] });
}

function mkWc(execResult: unknown = hitJson()): {
  wc: ManagedWebContents;
  events: Array<Record<string, unknown>>;
  exec: Mock;
} {
  const events: Array<Record<string, unknown>> = [];
  const exec = vi.fn(async () => execResult);
  const wc: ManagedWebContents = {
    loadURL: vi.fn(async () => undefined),
    on: vi.fn(),
    executeJavaScript: exec,
    sendInputEvent: vi.fn((e: { type: string }) => {
      events.push({ ...e } as Record<string, unknown>);
    }),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(0) })),
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    getURL: () => 'http://localhost:5173/',
    getTitle: () => 'test',
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  };
  return { wc, events, exec };
}

describe('resolveElement（解析 + JSON.parse；未命中含提示）', () => {
  it('命中：executeJavaScript 收到含转义 selector 的脚本；返回矩形字段', async () => {
    const { wc, exec } = mkWc();
    const el = await resolveElement(wc, '.btn"q');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toContain(JSON.stringify('.btn"q'));
    expect(el).toEqual(HIT_RECT);
  });

  it('未命中（rect:null）→ BrowserSelectorError，message 含「已匹配 0 个」与页内提示', async () => {
    const hints = ['button "登录" → text=登录', 'link "注册" → text=注册'];
    const { wc } = mkWc(JSON.stringify({ rect: null, hints }));
    await expect(resolveElement(wc, 'text=不存在')).rejects.toThrow(BrowserSelectorError);
    await expect(resolveElement(wc, 'text=不存在')).rejects.toThrow(/已匹配 0 个/);
    await expect(resolveElement(wc, 'text=不存在')).rejects.toThrow(/text=登录/);
  });

  it('executeJavaScript 返回非字符串（null——渲染进程异常/旧形态）→ BrowserSelectorError', async () => {
    // 注：传 undefined 会命中 mkWc 默认参数（JS 默认参语义），故用 null 表达异常形态
    const { wc } = mkWc(null);
    await expect(resolveElement(wc, '#go')).rejects.toThrow(BrowserSelectorError);
  });

  it('零尺寸矩形（display:none 子树——width 0）→ BrowserSelectorError', async () => {
    const { wc } = mkWc(JSON.stringify({ rect: { x: 0, y: 0, width: 0, height: 10, description: 'x' }, hints: [] }));
    await expect(resolveElement(wc, '#hidden')).rejects.toThrow(BrowserSelectorError);
  });

  it('非法 selector（纯前缀）→ 直接抛 BrowserSelectorError，不触 executeJavaScript', async () => {
    const { wc, exec } = mkWc();
    await expect(resolveElement(wc, 'text=')).rejects.toThrow(BrowserSelectorError);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('clickElement（mouseDown+mouseUp 序列于元素中心；trusted 事件经 sendInputEvent）', () => {
  it('序列与坐标（中心 = x+width/2, y+height/2）；button left / clickCount 1', async () => {
    const { wc, events } = mkWc();
    await clickElement(wc, '#go');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'mouseDown', x: 125, y: 210, button: 'left', clickCount: 1 });
    expect(events[1]).toMatchObject({ type: 'mouseUp', x: 125, y: 210, button: 'left', clickCount: 1 });
  });

  it('guard 包裹输入派发——事件仅在 guard 回调内发出（manager 自锁语义）', async () => {
    const { wc, events } = mkWc();
    const seen: string[] = [];
    await clickElement(wc, '#go', (run) => {
      seen.push('guard-in');
      run();
      seen.push('guard-out');
    });
    expect(seen).toEqual(['guard-in', 'guard-out']);
    expect(events.map((e) => e['type'])).toEqual(['mouseDown', 'mouseUp']);
  });

  it('未命中 → 不派发任何输入事件', async () => {
    const { wc, events } = mkWc(JSON.stringify({ rect: null, hints: [] }));
    await expect(clickElement(wc, '.missing')).rejects.toThrow(BrowserSelectorError);
    expect(events).toHaveLength(0);
  });
});

describe('typeText（先 click 聚焦 → char 逐字符 → 可选 Enter）', () => {
  it("submit=true：mouseDown/Up + char×N + keyDown/Up Enter", async () => {
    const { wc, events } = mkWc();
    await typeText(wc, '#q', 'hi', true);
    expect(events.map((e) => e['type'])).toEqual([
      'mouseDown',
      'mouseUp',
      'char',
      'char',
      'keyDown',
      'keyUp',
    ]);
    expect(events[2]).toMatchObject({ type: 'char', keyCode: 'h' });
    expect(events[3]).toMatchObject({ type: 'char', keyCode: 'i' });
    expect(events[4]).toMatchObject({ type: 'keyDown', keyCode: 'Enter' });
    expect(events[5]).toMatchObject({ type: 'keyUp', keyCode: 'Enter' });
  });

  it('submit 缺省 false：末尾无 Enter', async () => {
    const { wc, events } = mkWc();
    await typeText(wc, '#q', 'hi');
    expect(events.map((e) => e['type'])).toEqual(['mouseDown', 'mouseUp', 'char', 'char']);
  });

  it('多字节文本按码点逐字符（for..of 不拆代理对）', async () => {
    const { wc, events } = mkWc();
    await typeText(wc, '#q', '你好');
    expect(events.filter((e) => e['type'] === 'char')).toEqual([
      { type: 'char', keyCode: '你' },
      { type: 'char', keyCode: '好' },
    ]);
  });
});

describe('pressKey（白名单）', () => {
  const WHITELIST = [
    'Enter',
    'Tab',
    'Escape',
    'PageDown',
    'PageUp',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
  ] as const;

  it('白名单 9 键全过：keyDown + keyUp 成对', () => {
    for (const key of WHITELIST) {
      const { wc, events } = mkWc();
      pressKey(wc, key);
      expect(events).toEqual([
        { type: 'keyDown', keyCode: key },
        { type: 'keyUp', keyCode: key },
      ]);
    }
  });

  it('白名单外按键 → BrowserInvalidKeyError 且不派发事件（防修饰键/快捷键注入）', () => {
    for (const bad of ['Control', 'Meta', 'a', 'Return', 'F5', '']) {
      const { wc, events } = mkWc();
      expect(() => pressKey(wc, bad)).toThrow(BrowserInvalidKeyError);
      expect(events).toHaveLength(0);
    }
  });
});

describe('hoverElement（mouseMove 至中心——Electron 事件名，非 CDP mouseMoved）', () => {
  it('单事件 mouseMove 于元素中心', async () => {
    const { wc, events } = mkWc();
    await hoverElement(wc, '#go');
    expect(events).toEqual([{ type: 'mouseMove', x: 125, y: 210 }]);
  });
});

describe('scrollWheel（mouseWheel；amount 缺省 3；up 取负）', () => {
  it('down 缺省 → deltaY +300（3 格 × 100px/格）', () => {
    const { wc, events } = mkWc();
    scrollWheel(wc, 'down');
    expect(events[0]).toMatchObject({ type: 'mouseWheel', deltaX: 0, deltaY: 300 });
  });

  it('up 缺省取负；显式 amount 按格数缩放', () => {
    const up = mkWc();
    scrollWheel(up.wc, 'up');
    expect(up.events[0]).toMatchObject({ deltaY: -300 });
    const up5 = mkWc();
    scrollWheel(up5.wc, 'up', 5);
    expect(up5.events[0]).toMatchObject({ deltaY: -500 });
    const down2 = mkWc();
    scrollWheel(down2.wc, 'down', 2);
    expect(down2.events[0]).toMatchObject({ deltaY: 200 });
  });

  it('非法 amount（0 / 负 / 非整数 / NaN——防方向语义反转）→ 抛错且不派发', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const { wc, events } = mkWc();
      expect(() => scrollWheel(wc, 'down', bad)).toThrow(/amount/);
      expect(events).toHaveLength(0);
    }
  });
});
