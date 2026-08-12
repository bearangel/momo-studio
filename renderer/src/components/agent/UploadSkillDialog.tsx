// renderer/src/components/agent/UploadSkillDialog.tsx
// v1.6 Task 14：本地 .zip 包上传自定义 Skill 弹窗。
//
// 流程：
//   1. 用户点 [选择文件...] → <input type="file" accept=".zip"> 弹原生选择器
//   2. 选中后：回显文件名；读 ArrayBuffer（await file.arrayBuffer()）
//   3. 点 [上传] → ipc.skill.uploadZip(buffer, file.name)
//      后端返回 { slug, description }，前端显示成功提示
//   4. 成功 → onSuccess() 通知父组件刷新列表 → onClose() 关闭
//   5. 失败（zip 缺 SKILL.md / 多根目录 / 解压失败）→ 红字错误，弹窗保持打开
//
// 简化版：无预检（previewZip），失败时由后端一次性抛错，前端展示。
//
// 约束：
//   - 未选文件 → 上传按钮 disabled
//   - 上传中 → 选择文件 / 取消 / 上传 全部 disabled（防双击）
//   - 中文界面 + 中文注释
import { useRef, useState, type ChangeEvent } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';

/**
 * 用 FileReader 把 File 读成 ArrayBuffer。
 * 不能用 file.arrayBuffer()——jsdom 24（单元测试环境）未实现该方法，
 * 会被误以为是"现代化重构"而 silently 破坏测试。FileReader 在浏览器和 jsdom 都可用。
 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

interface Props {
  onClose: () => void;
  /** 上传成功后调用（父组件据此刷新已安装 skill 列表） */
  onSuccess: () => void;
}

export function UploadSkillDialog({ onClose, onSuccess }: Props) {
  // 选中的 zip 文件（File 对象）。null=未选
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // 隐藏的 input[type=file]，由 [选择文件...] 按钮触发 click
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = (): void => {
    inputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFile(picked);
    // 重新选文件时清掉上一次的成功 / 错误信息
    setError(null);
    setSuccessMsg(null);
  };

  const handleUpload = async (): Promise<void> => {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      // readFileAsArrayBuffer 拿到 ArrayBuffer；preload 层 Buffer.from(buffer) 转 Node Buffer，
      // 再经 ipcRenderer.invoke 序列化传给主进程 skill:uploadZip handler。
      // v1.6.2 起后端返回 UploadedSkill[]（支持扁平 / 包裹 / 多 skill 批量三种 zip 结构）。
      const buffer = await readFileAsArrayBuffer(file);
      const skills = await ipc.skill.uploadZip(buffer, file.name);
      // 成功提示：1 个显示 skill 名 + 描述；多个显示数量 + slug 列表
      const msg =
        skills.length === 1
          ? `已安装：${skills[0]!.slug}（${skills[0]!.description}）`
          : `已安装 ${skills.length} 个 skill：${skills.map((s) => s.slug).join(', ')}`;
      setSuccessMsg(msg);
      // v1.6.3 修复：先触发父组件刷新，再关弹窗。之前立即 onClose 导致：
      // (a) 用户看不到 successMsg（dialog 已 unmount）
      // (b) 父组件刷新结果用户看不到（弹窗刚关，列表更新被忽略）
      onSuccess();
      // 不立即 onClose——保留成功消息让用户看到，用户手动点关闭/取消
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  // 操作锁：上传中时所有可交互元素 disabled
  const lockAll = uploading;
  const canUpload = file !== null && !uploading;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={lockAll ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">上传自定义 Skill</h2>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">Skill 压缩包（.zip）</label>
            <div className="flex gap-2 items-center">
              <Button
                variant="ghost"
                type="button"
                onClick={handlePick}
                disabled={lockAll}
              >
                选择文件...
              </Button>
              <span className="text-sm text-neutral-400 truncate flex-1">
                {file ? file.name : '未选择文件'}
              </span>
            </div>
            {/* 隐藏的文件选择 input。aria-label 让测试可定位 */}
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFileChange}
              className="hidden"
              aria-label="选择文件"
              disabled={lockAll}
            />
            <p className="text-xs text-neutral-500 mt-1">
              支持三种 zip 结构：扁平（<code>SKILL.md</code> 在根目录）、
              单子目录包裹（<code>{'<slug>/SKILL.md'}</code>）、多子目录批量（多个
              <code>{'<slug>/'}</code>）。SKILL.md 顶部要有 YAML frontmatter（含
              name / description）。macOS 的 <code>__MACOSX</code> 元数据会自动忽略。
            </p>
          </div>

          {successMsg && (
            <div className="text-green-400 text-sm break-all">{successMsg}</div>
          )}
          {error && <div className="text-red-400 text-sm break-all">{error}</div>}

          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose} disabled={lockAll}>
              取消
            </Button>
            <Button type="button" onClick={handleUpload} disabled={!canUpload}>
              {uploading ? '上传中…' : '上传'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
