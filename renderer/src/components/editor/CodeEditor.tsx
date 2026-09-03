// renderer/src/components/editor/CodeEditor.tsx
// Monaco 编辑器组件：多 tab 栏 + 编辑区 + Ctrl+S 保存（IPC file:write）
// v2.1 P3：tab 栏/空态 token 化（EmptyState + File/X lucide）；主题接线（P2 Task 10）不动
import { useCallback, useState } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { File, X } from 'lucide-react';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useThemeStore } from '../../stores/theme.store';
import { ipc } from '../../ipc/client';
import { cn } from '../../lib/cn';
import { EmptyState } from '../ui/EmptyState';

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

  // tab 自身键盘激活：Enter/Space 与 onClick 等价（外层已 div role=tab，不可自然得 button 的 Enter 语义）
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, filePath: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setActive(filePath);
      }
    },
    [setActive],
  );

  // 无 tab 时显示空状态
  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={File} title="双击文件打开编辑器" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col" onKeyDown={handleKeyDown}>
      {/* Tab 栏 */}
      <div className="flex bg-surface-1 border-b border-subtle overflow-x-auto">
        {tabs.map((tab) => {
          const tabName = tab.filePath.split('/').pop() ?? '';
          const isActive = tab.filePath === activeTab;
          return (
            // 外层 div + role=tab：避免嵌套 button（HTML 非法）；tabIndex 0 + onKeyDown Enter/Space 保持键盘可激活
            <div
              key={tab.filePath}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              onClick={() => setActive(tab.filePath)}
              onKeyDown={(e) => handleTabKeyDown(e, tab.filePath)}
              className={cn(
                'px-3 py-1.5 text-sm border-r border-subtle flex items-center gap-2 whitespace-nowrap cursor-pointer',
                isActive ? 'bg-surface-2 text-primary' : 'hover:bg-surface-3',
              )}
            >
              {/* dirty 标记（● 文本，非 emoji） */}
              <span>{tab.dirty ? '●' : ''}</span>
              <span className="truncate max-w-[150px]">{tabName}</span>
              <button
                type="button"
                aria-label={`关闭 ${tabName}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.filePath);
                }}
                className="text-tertiary hover:text-primary ml-1"
              >
                <X size={12} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          );
        })}
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
