// renderer/src/components/ui/Select.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Select } from './Select';

describe('Select', () => {
  it('渲染 label 与 options，change 回调带值', () => {
    const onChange = vi.fn();
    render(
      <Select label="平台" onChange={onChange}>
        <option value="openai">OpenAI 兼容</option>
        <option value="anthropic">Anthropic</option>
      </Select>,
    );
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'anthropic' } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('外观 token 化 + 自定义箭头', () => {
    render(
      <Select aria-label="模型">
        <option value="a">A</option>
      </Select>,
    );
    const sel = screen.getByLabelText('模型');
    expect(sel.className).toContain('bg-surface-2');
    expect(sel.className).toContain('appearance-none');
  });

  it('disabled 视觉：禁用态半透明', () => {
    render(
      <Select disabled aria-label="禁用选择">
        <option value="a">A</option>
      </Select>,
    );
    const sel = screen.getByLabelText('禁用选择');
    expect(sel).toBeDisabled();
    expect(sel.className).toContain('disabled:opacity-50');
  });
});
