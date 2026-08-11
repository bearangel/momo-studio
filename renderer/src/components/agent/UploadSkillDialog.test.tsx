// renderer/src/components/agent/UploadSkillDialog.test.tsx
//
// v1.6 Task 14：UploadSkillDialog 测试——本地 zip 上传自定义 skill。
//
// 行为约定：
//   - 渲染：标题 + [选择文件...] 按钮 + 取消 / 上传 按钮
//   - 初始状态：未选文件 → 「上传」按钮 disabled
//   - 选择 zip 文件 → 文件名回显
//   - 点击「上传」→ 读 ArrayBuffer → ipc.skill.uploadZip(buffer, filename)
//   - 成功 → onSuccess() + onClose()
//   - 失败（zip 缺 SKILL.md / 多根目录 / 解压失败）→ 红字错误，弹窗保持打开
//   - 上传中 → 按钮 disabled（防双击）
//
// Mock 策略：window.api.skill.uploadZip 桩 + File 构造模拟用户选文件。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UploadSkillDialog } from './UploadSkillDialog';

// ---- mock IPC 桩 ----
const uploadZip = vi.fn();
const mockApi = {
  skill: { uploadZip },
};

beforeEach(() => {
  uploadZip.mockReset();
  uploadZip.mockResolvedValue({ slug: 'demo-skill', description: '示例 skill' });
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

/** 用 fireEvent.change 模拟用户在 input[type=file] 上选了 zip 文件 */
function pickZip(file: File): void {
  const input = screen.getByLabelText('选择文件') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('UploadSkillDialog — 本地 zip 上传自定义 skill', () => {
  it('渲染：标题 + 选择文件按钮 + 取消 / 上传按钮', () => {
    render(<UploadSkillDialog onClose={() => {}} onSuccess={() => {}} />);
    expect(screen.getByText('上传自定义 Skill')).toBeInTheDocument();
    expect(screen.getByLabelText('选择文件')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传' })).toBeInTheDocument();
  });

  it('初始状态：未选文件 → 「上传」按钮 disabled', () => {
    render(<UploadSkillDialog onClose={() => {}} onSuccess={() => {}} />);
    expect(screen.getByRole('button', { name: '上传' })).toBeDisabled();
  });

  it('选择 zip 文件后回显文件名，上传按钮变为 enabled', () => {
    render(<UploadSkillDialog onClose={() => {}} onSuccess={() => {}} />);
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'my-skill.zip', {
      type: 'application/zip',
    });
    pickZip(file);
    expect(screen.getByText('my-skill.zip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传' })).toBeEnabled();
  });

  it('点击「上传」→ ipc.skill.uploadZip 收到 ArrayBuffer + 文件名', async () => {
    render(<UploadSkillDialog onClose={() => {}} onSuccess={() => {}} />);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    const file = new File([bytes], 'demo.zip', { type: 'application/zip' });
    pickZip(file);

    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      expect(uploadZip).toHaveBeenCalledTimes(1);
    });
    const [buf, filename] = uploadZip.mock.calls[0]!;
    expect(filename).toBe('demo.zip');
    // ArrayBuffer 长度 = 原 bytes 长度，且首字节是 zip magic 0x50
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect((buf as ArrayBuffer).byteLength).toBe(bytes.byteLength);
    const view = new Uint8Array(buf as ArrayBuffer);
    expect(view[0]).toBe(0x50);
  });

  it('上传成功 → 触发 onSuccess + onClose', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<UploadSkillDialog onClose={onClose} onSuccess={onSuccess} />);
    pickZip(new File([new Uint8Array([0])], 'ok.zip', { type: 'application/zip' }));

    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('上传成功 → 显示成功提示（含 slug）', async () => {
    uploadZip.mockResolvedValue({ slug: 'demo-skill', description: '示例 skill' });
    render(<UploadSkillDialog onClose={() => {}} onSuccess={() => {}} />);
    pickZip(new File([new Uint8Array([0])], 'ok.zip', { type: 'application/zip' }));

    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      expect(screen.getByText(/demo-skill/)).toBeInTheDocument();
    });
  });

  it('失败（zip 缺 SKILL.md）→ 红字错误，弹窗保持打开，onSuccess 不触发', async () => {
    uploadZip.mockRejectedValueOnce(new Error('zip 内未找到 SKILL.md（要求 <slug>/SKILL.md 结构）'));
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<UploadSkillDialog onClose={onClose} onSuccess={onSuccess} />);
    pickZip(new File([new Uint8Array([0])], 'bad.zip', { type: 'application/zip' }));

    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      expect(screen.getByText(/未找到 SKILL\.md/)).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('失败（多根目录）→ 红字错误展示具体原因', async () => {
    uploadZip.mockRejectedValueOnce(
      new Error('zip 根目录包含多个子目录（应有且仅有一个 <slug>/ 包裹 SKILL.md）'),
    );
    render(<UploadSkillDialog onClose={() => {}} onSuccess={() => {}} />);
    pickZip(new File([new Uint8Array([0])], 'multi.zip', { type: 'application/zip' }));

    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      expect(screen.getByText(/多个子目录/)).toBeInTheDocument();
    });
  });

  it('上传中 → 按钮 disabled（防双击），uploadZip 仅被调一次', async () => {
    // 用未决 Promise 卡住上传
    let resolveUpload: (v: { slug: string; description: string }) => void = () => {};
    uploadZip.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    render(<UploadSkillDialog onClose={() => {}} onSuccess={() => {}} />);
    pickZip(new File([new Uint8Array([0])], 'slow.zip', { type: 'application/zip' }));

    fireEvent.click(screen.getByRole('button', { name: '上传' }));
    // 上传进行中：按钮文案变化 + disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '上传中…' })).toBeDisabled();
    });
    // 再次点击不应触发第二次调用
    fireEvent.click(screen.getByRole('button', { name: '上传中…' }));
    // FileReader.onload 异步——必须 waitFor（与 RegisterMcp 测试的同步断言不同），
    // 否则并发跑测时会偶发 uploadZip 未被调用就断言。第二次点击被 uploading 守卫吞掉。
    await waitFor(() => {
      expect(uploadZip).toHaveBeenCalledTimes(1);
    });

    // 解除卡死，让组件清理
    resolveUpload({ slug: 'slow', description: '' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '上传' })).toBeEnabled();
    });
  });

  it('取消按钮 → 触发 onClose，不触发上传', () => {
    const onClose = vi.fn();
    render(<UploadSkillDialog onClose={onClose} onSuccess={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(uploadZip).not.toHaveBeenCalled();
  });
});
