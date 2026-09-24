// renderer/src/components/ui/KeyValueRows.test.tsx
// P2.4 Task 2：键值对行编辑器原子件——env / headers 同构复用。
// 行 = KEY 输入 + VALUE 输入 + 删除钮；底部「+ 添加」。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { KeyValueRows, type KVRow } from './KeyValueRows';

const base = {
  keyPlaceholder: '变量名',
  valuePlaceholder: '值',
  addLabel: '添加环境变量',
  ariaLabel: '环境变量',
};

describe('KeyValueRows', () => {
  it('渲染每行 KEY/VALUE 两输入 + 删除钮', () => {
    render(<KeyValueRows {...base} rows={[{ key: 'FOO', value: 'bar' }]} onChange={() => {}} />);
    expect(screen.getByDisplayValue('FOO')).toBeInTheDocument();
    expect(screen.getByDisplayValue('bar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除第 1 行' })).toBeInTheDocument();
  });

  it('修改 KEY → onChange 回传新 rows（原行对象不 mutate）', () => {
    const onChange = vi.fn();
    const rows: KVRow[] = [{ key: 'A', value: '1' }];
    render(<KeyValueRows {...base} rows={rows} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue('A'), { target: { value: 'B' } });
    expect(onChange).toHaveBeenCalledWith([{ key: 'B', value: '1' }]);
    // 原数组不被 mutate（受控组件纪律）
    expect(rows[0]!.key).toBe('A');
  });

  it('点删除钮 → onChange 回传剔除该行的数组；仅剩一行也可删成空数组', () => {
    const onChange = vi.fn();
    render(<KeyValueRows {...base} rows={[{ key: 'A', value: '1' }, { key: 'B', value: '2' }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '删除第 2 行' }));
    expect(onChange).toHaveBeenCalledWith([{ key: 'A', value: '1' }]);
    // 单行场景（同用例内二次 render——setup 的 afterEach(cleanup) 不覆盖，需手动清理 DOM）
    cleanup();
    const onChange2 = vi.fn();
    render(<KeyValueRows {...base} rows={[{ key: 'X', value: 'y' }]} onChange={onChange2} />);
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 行' }));
    expect(onChange2).toHaveBeenCalledWith([]);
  });

  it('点「+ 添加」→ onChange 追加一行空键值', () => {
    const onChange = vi.fn();
    render(<KeyValueRows {...base} rows={[{ key: 'A', value: '1' }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '添加环境变量' }));
    expect(onChange).toHaveBeenCalledWith([{ key: 'A', value: '1' }, { key: '', value: '' }]);
  });
});
