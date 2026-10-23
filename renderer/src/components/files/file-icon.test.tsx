// renderer/src/components/files/file-icon.test.tsx
// 文件树图标（方案 A，2026-10-23 预览批准稿）契约锁：
// - 解析优先级同 VS Code：精确文件名 > 多点扩展名 > 扩展名 > document 兜底
// - 目录名 → folder-* 变体（展开取 *-open），未命中取派生通用 folder
// - 组件渲染真实生成资产（内联 path，非占位）——实现不得偏离预览所见
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { fileIconKey, folderIconKey, FileTypeIcon, FolderTypeIcon } from './file-icon';
import { FILE_ICONS } from './file-icons.generated';

describe('fileIconKey 解析优先级（VS Code 序）', () => {
  it('精确文件名优先于扩展名：package.json → npm（而非 json）', () => {
    expect(fileIconKey('package.json')).toBe('npm');
    expect(fileIconKey('Dockerfile')).toBe('docker');
    expect(fileIconKey('pnpm-lock.yaml')).toBe('pnpm');
  });

  it.each([
    ['main.ts', 'typescript'],
    ['app.tsx', 'typescript'],
    ['index.js', 'javascript'],
    ['data.json', 'json'],
    ['README.md', 'markdown'],
    ['conf.yaml', 'yaml'],
    ['pyproject.toml', 'toml'],
    ['style.css', 'css'],
    ['var.scss', 'sass'],
    ['page.vue', 'html'],
    ['main.py', 'python'],
    ['srv.go', 'go'],
    ['lib.rs', 'rust'],
    ['util.c', 'c'],
    ['lib.cpp', 'cpp'],
    ['Main.java', 'java'],
    ['gem.rb', 'ruby'],
    ['demo.php', 'php'],
    ['app.swift', 'swift'],
    ['main.kt', 'kotlin'],
    ['run.sh', 'console'],
    ['query.sql', 'database'],
    ['logo.png', 'image'],
    ['clip.mp4', 'video'],
    ['tone.mp3', 'audio'],
    ['doc.docx', 'word'],
    ['slide.pptx', 'powerpoint'],
    ['paper.pdf', 'pdf'],
    ['bundle.zip', 'zip'],
    ['cert.pem', 'certificate'],
    ['.env', 'lock'],
    ['.gitignore', 'git'],
  ])('%s → %s', (name, key) => {
    expect(fileIconKey(name)).toBe(key);
  });

  it('大小写不敏感：DOCKERFILE / MAIN.PY 命中', () => {
    expect(fileIconKey('DOCKERFILE')).toBe('docker');
    expect(fileIconKey('MAIN.PY')).toBe('python');
  });

  it('多点扩展名回退：lib.d.ts → d.ts 未命中再回 ts', () => {
    expect(fileIconKey('lib.d.ts')).toBe('typescript');
  });

  it.each(['unknown.xyz', 'binfile', 'noext'])(
    '%s → document 兜底',
    (name) => {
      expect(fileIconKey(name)).toBe('document');
    },
  );

  it('无扩展名裸名（Makefile 走精确名）：makefile', () => {
    expect(fileIconKey('Makefile')).toBe('makefile');
  });
});

describe('folderIconKey 目录变体', () => {
  it.each([
    ['src', 'src'],
    ['test', 'test'],
    ['__tests__', 'test'],
    ['docs', 'docs'],
    ['node_modules', 'node'],
    ['dist', 'dist'],
    ['build', 'dist'],
    ['utils', 'utils'],
    ['scripts', 'scripts'],
    ['examples', 'examples'],
  ])('%s → folder-%s', (name, short) => {
    expect(folderIconKey(name)).toBe(short);
  });

  it('未命中目录名 → null（通用 folder）', () => {
    expect(folderIconKey('我的目录')).toBeNull();
    expect(folderIconKey('core-stuff')).toBeNull();
  });
});

describe('组件渲染生成资产', () => {
  it('FileTypeIcon 渲染解析到的真实 SVG path（彩色内联）', () => {
    const { container } = render(<FileTypeIcon name="main.ts" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('path')?.getAttribute('fill')).toBe(
      FILE_ICONS.typescript!.body.match(/fill="([^"]+)"/)![1],
    );
  });

  it('json 图标 viewBox 含 top 偏移（Material Symbols 960 网格，2026-10-23 空白事故锁）', () => {
    const { container } = render(<FileTypeIcon name="data.json" />);
    // 上游 icons.json：json = { top: -960, width: 960, height: 960 }——丢偏移会让
    // viewBox 对准空白象限，渲染成「没有图标」
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(container.querySelector('svg path')?.getAttribute('fill')).toBe('#f9a825');
  });

  it('全量资产几何完整性：每个图标 l/t/w/h 有限且 body 含 path（防静默空白）', () => {
    for (const [key, data] of Object.entries(FILE_ICONS)) {
      for (const v of [data.l, data.t, data.w, data.h]) {
        expect(Number.isFinite(v), `${key} 几何字段非法`).toBe(true);
      }
      expect(data.w, `${key} 宽度非正`).toBeGreaterThan(0);
      expect(data.h, `${key} 高度非正`).toBeGreaterThan(0);
      expect(data.body.includes('<path'), `${key} body 无 path`).toBe(true);
    }
  });

  it('未知类型回退 document 资产（不空渲染）', () => {
    const { container } = render(<FileTypeIcon name="what.is.this" />);
    expect(container.querySelector('svg path')).not.toBeNull();
  });

  it('FolderTypeIcon 命中变体：src 折叠/展开分别取 folder-src / folder-src-open', () => {
    const folded = render(<FolderTypeIcon name="src" />).container.querySelector('svg path');
    const open = render(<FolderTypeIcon name="src" expanded />).container.querySelector('svg path');
    expect(folded?.getAttribute('d')).toBe(
      FILE_ICONS['folder-src']!.body.match(/d="([^"]+)"/)![1],
    );
    expect(open?.getAttribute('d')).toBe(
      FILE_ICONS['folder-src-open']!.body.match(/d="([^"]+)"/)![1],
    );
  });

  it('FolderTypeIcon 未命中取派生通用 folder（_folder / _folder-open）', () => {
    const folded = render(<FolderTypeIcon name="杂项" />).container.querySelector('svg path');
    const open = render(<FolderTypeIcon name="杂项" expanded />).container.querySelector('svg path');
    expect(folded?.getAttribute('fill')).toBe('#90A4AE');
    expect(open?.getAttribute('d')).toBe(FILE_ICONS['_folder-open']!.body.match(/d="([^"]+)"/)![1]);
  });
});
