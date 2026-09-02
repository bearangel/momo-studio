// renderer/src/components/editor/CodeEditor.tsx
// Monaco 编辑器组件：多 tab 栏 + 编辑区 + Ctrl+S 保存（IPC file:write）
import { useCallback, useState } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useThemeStore } from '../../stores/theme.store';
import { ipc } from '../../ipc/client';
import { cn } from '../../lib/cn';

export function CodeEditor() {
  const { tabs, activeTab, updateContent, markSaved, setActive, closeTab } =
    useEditorStore();
  const workspace = useWorkspaceStore((s) => s.getActive());
  const resolved = useThemeStore((s) => s.resolved);
  const [themeFallback, setThemeFallback] = useState(false);
  const activeTabData = tabs.find((t) => t.filePath === activeTab);

  // Ctrl/Cmd+S 保存当前 tab 内容到磁盘
  const handleSave = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const tab = tabs.find((t) => t.filePath === filePath);
      if (!tab) return;
      await ipc.file.write(workspace.id, filePath, tab.content);
      markSaved(filePath);
    },
    [workspace, tabs, markSaved],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (activeTab) void handleSave(activeTab);
      }
    },
    [activeTab, handleSave],
  );

  // 无 tab 时显示空状态
  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <div className="text-center">
          <div className="text-4xl mb-2">📄</div>
          <p className="text-sm">双击文件打开编辑器</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col" onKeyDown={handleKeyDown}>
      {/* Tab 栏 */}
      <div className="flex bg-bg-secondary border-b border-border-subtle overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.filePath}
            onClick={() => setActive(tab.filePath)}
            className={cn(
              'px-3 py-1.5 text-sm border-r border-border-subtle flex items-center gap-2 whitespace-nowrap',
              tab.filePath === activeTab ? 'bg-bg-primary' : 'hover:bg-bg-tertiary',
            )}
          >
            {/* dirty 标记 */}
            <span>{tab.dirty ? '●' : ''}</span>
            <span className="truncate max-w-[150px]">
              {tab.filePath.split('/').pop()}
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.filePath);
              }}
              className="text-neutral-500 hover:text-white ml-1"
            >
              ×
            </span>
          </button>
        ))}
      </div>

      {/* Monaco 编辑器 */}
      {activeTabData && (
        <Editor
          height="100%"
          theme={
            themeFallback
              ? resolved === 'dark'
                ? 'vs-dark'
                : 'vs'
              : resolved === 'dark'
                ? 'momo-dark'
                : 'momo-light'
          }
          beforeMount={(monaco: Monaco) => {
            // v2.1 双主题：编辑器底色对齐 canvas token（bg-canvas 的 hex 值），
            // 注册失败回退内置 vs/vs-dark（catch 防御——spec §12 错误处理）
            try {
              monaco.editor.defineTheme('momo-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [],
                colors: {
                  'editor.background': '#08090A',
                  'editor.lineHighlightBackground': '#181A1F',
                  'editorLineNumber.foreground': '#7F828B',
                  'editor.selectionBackground': '#5E6AD255',
                },
              });
              monaco.editor.defineTheme('momo-light', {
                base: 'vs',
                inherit: true,
                rules: [],
                colors: {
                  'editor.background': '#FFFFFF',
                  'editor.lineHighlightBackground': '#F1F1F3',
                  'editorLineNumber.foreground': '#82858F',
                  'editor.selectionBackground': '#5E6AD230',
                },
              });
            } catch {
              // 注册失败回退：theme prop 兜底用内置主题
              setThemeFallback(true);
            }
          }}
          language={detectLanguage(activeTabData.filePath)}
          value={activeTabData.content}
          onChange={(value) => {
            if (value !== undefined && activeTab) {
              updateContent(activeTab, value);
            }
          }}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      )}
    </div>
  );
}

// 根据扩展名映射 Monaco 语言 ID
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    go: 'go',
    rs: 'rust',
    css: 'css',
    html: 'html',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
  };
  return map[ext ?? ''] ?? 'plaintext';
}
