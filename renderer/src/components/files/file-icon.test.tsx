// renderer/src/components/files/file-icon.test.tsx
// fileIconFor 契约锁：扩展名 → { icon 形状, 静态 className }。
// 映射 = 2026-10-11 P1 预览方案 B（用户批准稿）——实现不得偏离预览所见。
// className 必须是字面量（Tailwind 编译期生成约束，禁动态拼接）。
import { describe, it, expect } from 'vitest';
import { fileIconFor, FOLDER_ICON_CLASS } from './file-icon';
import { File, FileCode, FileImage, FileArchive, Braces, FileText } from 'lucide-react';

describe('fileIconFor 形状+着色（方案 B 批准稿）', () => {
  it.each(['a.ts', 'app.tsx', 'styles.css'])('%s → FileCode + text-icon-code', (name) => {
    const spec = fileIconFor(name);
    expect(spec.icon).toBe(FileCode);
    expect(spec.className).toBe('text-icon-code');
  });

  it.each(['main.js', 'App.jsx'])('%s → FileCode + text-icon-js', (name) => {
    const spec = fileIconFor(name);
    expect(spec.icon).toBe(FileCode);
    expect(spec.className).toBe('text-icon-js');
  });

  it('data.json → Braces + text-icon-js', () => {
    const spec = fileIconFor('data.json');
    expect(spec.icon).toBe(Braces);
    expect(spec.className).toBe('text-icon-js');
  });

  it('main.py → FileCode + text-status-success（复用状态绿）', () => {
    const spec = fileIconFor('main.py');
    expect(spec.icon).toBe(FileCode);
    expect(spec.className).toBe('text-status-success');
  });

  it.each(['logo.png', 'a.jpg', 'b.jpeg', 'i.svg', 'p.webp', 'g.gif'])(
    '%s → FileImage + text-status-violet（复用状态紫）',
    (name) => {
      const spec = fileIconFor(name);
      expect(spec.icon).toBe(FileImage);
      expect(spec.className).toBe('text-status-violet');
    },
  );

  it.each(['中文报告.md', 'a.txt'])('%s → FileText + text-icon-md', (name) => {
    const spec = fileIconFor(name);
    expect(spec.icon).toBe(FileText);
    expect(spec.className).toBe('text-icon-md');
  });

  it.each(['bundle.zip', 'x.tar', 'y.gz'])('%s → FileArchive + text-status-warning', (name) => {
    const spec = fileIconFor(name);
    expect(spec.icon).toBe(FileArchive);
    expect(spec.className).toBe('text-status-warning');
  });

  it('index.html → File 轮廓 + text-status-warning（预览所见：html 不换形状）', () => {
    const spec = fileIconFor('index.html');
    expect(spec.icon).toBe(File);
    expect(spec.className).toBe('text-status-warning');
  });

  it('manual.pdf → FileText + text-status-error', () => {
    const spec = fileIconFor('manual.pdf');
    expect(spec.icon).toBe(FileText);
    expect(spec.className).toBe('text-status-error');
  });

  it('大写扩展名归一：LOGO.PNG → FileImage + violet', () => {
    const spec = fileIconFor('LOGO.PNG');
    expect(spec.icon).toBe(FileImage);
    expect(spec.className).toBe('text-status-violet');
  });

  it.each(['Makefile', 'Dockerfile', 'data.unknownext', ''])(
    '%s（无/未知扩展）→ File + text-tertiary 中性兜底',
    (name) => {
      const spec = fileIconFor(name);
      expect(spec.icon).toBe(File);
      expect(spec.className).toBe('text-tertiary');
    },
  );
});

describe('FOLDER_ICON_CLASS（目录琥珀）', () => {
  it('导出静态目录着色类名（Folder/FolderOpen 共用）', () => {
    expect(FOLDER_ICON_CLASS).toBe('text-icon-folder');
  });
});
