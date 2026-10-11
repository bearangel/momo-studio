// renderer/src/components/ui/EmojiPicker.test.tsx
//
// 保真度要点（momo-test-rules）：
// - Esc 契约用例复刻 Dialog.tsx 真实监听形态（window + capture + 同 commit
//   渲染使父 effect 晚于子注册）——不是简化 mock，是生产注册顺序的还原
// - 数据完整性用例锁 96 个 emoji 全局唯一非空（重复 key 会击穿网格渲染）
import { useEffect, useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker';
import { EMOJI_CATEGORIES, DEFAULT_CATEGORY } from './emoji-presets';

function setup(value = '🤖') {
  const onChange = vi.fn();
  render(<EmojiPicker label="图标" value={value} onChange={onChange} />);
  return { onChange };
}

/** 复刻 ui/Dialog.tsx 的 Esc 宿主：同一 commit 渲染 EmojiPicker（子）与本
 *  宿主（父），React 自底向上执行 effect → 子的 capture 监听先注册先触发，
 *  与生产「EmojiPicker 在 Dialog 内」的注册顺序一致 */
function makeDialogLikeHost() {
  const dialogEsc = vi.fn();
  const Host = () => {
    const [emoji, setEmoji] = useState('🤖');
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') dialogEsc();
      };
      window.addEventListener('keydown', onKeyDown, { capture: true });
      return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, []);
    return <EmojiPicker label="图标" value={emoji} onChange={setEmoji} />;
  };
  return { Host, dialogEsc };
}

describe('EmojiPicker - 渲染与受控', () => {
  it('触发器显示当前值；label 同时是触发器 aria-label（getByLabelText 可达）', () => {
    setup('🦊');
    const trigger = screen.getByLabelText('图标');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.textContent).toContain('🦊');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('value 为空 → 触发器渲染 Smile 兜底图标（svg），不显示空文本', () => {
    setup('');
    const trigger = screen.getByLabelText('图标');
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('disabled → 触发器不可点、弹层不展开（DefinitionEditor 只读态）', () => {
    const onChange = vi.fn();
    const initialValue = '🤖';
    render(<EmojiPicker label="图标" value={initialValue} onChange={onChange} disabled />);
    const trigger = screen.getByLabelText('图标');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('EmojiPicker - 展开与选择', () => {
  it('展开时默认定位到 value 所在分类（🤖 → 角色），当前值 aria-pressed 高亮', () => {
    setup('🤖');
    fireEvent.click(screen.getByLabelText('图标'));
    expect(screen.getByLabelText('图标')).toHaveAttribute('aria-expanded', 'true');
    // 角色 tab 激活
    expect(screen.getByRole('button', { name: '角色' })).toHaveAttribute('aria-pressed', 'true');
    // 🤖 在网格中且高亮；笑脸分类的 😀 不在当前网格
    expect(screen.getByLabelText('🤖')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('😀')).not.toBeInTheDocument();
  });

  it('value 不在预设集（YAML 导入等）→ 默认第一分类，网格内无任何高亮', () => {
    setup('🧑‍🌾');
    fireEvent.click(screen.getByLabelText('图标'));
    expect(screen.getByRole('button', { name: DEFAULT_CATEGORY.label })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const cells = DEFAULT_CATEGORY.emojis.map((e) => screen.getByLabelText(e));
    cells.forEach((cell) => expect(cell).toHaveAttribute('aria-pressed', 'false'));
  });

  it('点击 emoji → onChange 以该 emoji 调用一次，弹层收起', () => {
    const { onChange } = setup('🤖');
    fireEvent.click(screen.getByLabelText('图标'));
    fireEvent.click(screen.getByLabelText('👑'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('👑');
    expect(screen.getByLabelText('图标')).toHaveAttribute('aria-expanded', 'false');
  });

  it('切换分类 tab → 网格渲染该分类 emoji', () => {
    setup('🤖');
    fireEvent.click(screen.getByLabelText('图标'));
    fireEvent.click(screen.getByRole('button', { name: '办公' }));
    expect(screen.getByLabelText('🚀')).toBeInTheDocument();
    expect(screen.queryByLabelText('👻')).not.toBeInTheDocument();
  });
});

describe('EmojiPicker - 关闭路径', () => {
  it('再次点击触发器 → 收起', () => {
    setup('🤖');
    const trigger = screen.getByLabelText('图标');
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('弹层外 mousedown → 收起；弹层内 / 触发器 mousedown 不收起', () => {
    setup('🤖');
    const trigger = screen.getByLabelText('图标');
    fireEvent.click(trigger);
    // 弹层内 mousedown：不关
    fireEvent.mouseDown(screen.getByLabelText('👑'));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // 触发器 mousedown：不关（关停由 click toggle 承担）
    fireEvent.mouseDown(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // 锚点外 mousedown：关
    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('弹层 portal 到 body 且 fixed 定位——不被宿主对话框滚动容器裁剪（向导溢出 bug 回归锁）', () => {
    setup('🤖');
    fireEvent.click(screen.getByLabelText('图标'));
    const panel = document.querySelector('[aria-label="图标选择"]');
    if (!panel) throw new Error('弹层未渲染');
    // portal 落 body：任何 overflow 祖先（如 Dialog 的 overflow-auto 内容区）都裁不到它
    expect(panel.parentElement).toBe(document.body);
    expect(getComputedStyle(panel).position).toBe('fixed');
  });

  it('Esc 契约（Dialog 共存）：展开时 Esc 只收起选择器，宿主 Dialog 监听不被调用', () => {
    const { Host, dialogEsc } = makeDialogLikeHost();
    render(<Host />);
    fireEvent.click(screen.getByLabelText('图标'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('图标')).toHaveAttribute('aria-expanded', 'false');
    expect(dialogEsc).not.toHaveBeenCalled();
  });

  it('Esc 契约：收起态 Esc 放行——宿主 Dialog 监听正常收到', () => {
    const { Host, dialogEsc } = makeDialogLikeHost();
    render(<Host />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialogEsc).toHaveBeenCalledTimes(1);
  });
});

describe('emoji-presets - 数据完整性', () => {
  it('6 分类 × 16 = 96 个 emoji 全局唯一且非空', () => {
    expect(EMOJI_CATEGORIES).toHaveLength(6);
    EMOJI_CATEGORIES.forEach((cat) => {
      expect(cat.emojis).toHaveLength(16);
      expect(cat.key).not.toBe('');
      expect(cat.label).not.toBe('');
    });
    const all = EMOJI_CATEGORIES.flatMap((c) => c.emojis);
    expect(all).toHaveLength(96);
    expect(new Set(all).size).toBe(96);
    expect(all.every((e) => e.length > 0)).toBe(true);
  });
});
