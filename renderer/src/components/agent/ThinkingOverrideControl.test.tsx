// renderer/src/components/agent/ThinkingOverrideControl.test.tsx
//
// agent 级思维覆盖控件（spec §7.3）：跟随/关闭/开启(+档位)；能力 none 时整体隐藏。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingOverrideControl } from './ThinkingOverrideControl';
import type { ReasoningCapability } from '../../ipc/types';

beforeEach(() => {
  // Task 9 教训：属性赋值保留 jsdom window 本体（整体替换会让 react-dom 崩掉）
  (globalThis as unknown as { window: { api: unknown } }).window.api = { provider: {} };
});

const EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' };

describe('ThinkingOverrideControl', () => {
  it('能力 none → 不渲染', () => {
    const { container } = render(
      <ThinkingOverrideControl capability={{ kind: 'none' }} value={null} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('value=null → 跟随模型设置；选关闭/开启提交覆盖', () => {
    const onChange = vi.fn();
    render(<ThinkingOverrideControl capability={EFFORT} value={null} onChange={onChange} />);
    const sel = screen.getByLabelText('思维模式');
    expect((sel as HTMLSelectElement).value).toBe('inherit');
    fireEvent.change(sel, { target: { value: 'off' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'off', effort: null });
    fireEvent.change(sel, { target: { value: 'on' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'on', effort: 'max' });
  });

  it('effort 能力开启时渲染档位下拉并提交所选档', () => {
    const onChange = vi.fn();
    render(<ThinkingOverrideControl capability={EFFORT} value={{ mode: 'on', effort: 'high' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('思维档位'), { target: { value: 'low' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'on', effort: 'low' });
  });

  it('toggle 能力无档位下拉', () => {
    render(<ThinkingOverrideControl capability={{ kind: 'toggle' }} value={null} onChange={() => {}} />);
    expect(screen.queryByLabelText('思维档位')).toBeNull();
  });
});
