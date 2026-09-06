// renderer/src/components/im/CodeBlock.tsx
//
// 代码块渲染：语言标签行 + shiki 语法高亮（GitHub 式，无复制按钮——用户决策）。
// - shell 类围栏降饱和纯文本（终端输出不是源码）
// - deferHighlight=true（流式中的活跃段）纯文本渲染，段稳定后恢复高亮
// - 高亮未就绪期间渲染纯文本，就绪后注入（无专门 loading 态，无闪烁阻塞）
import { useEffect, useState } from 'react';
import { highlightCode } from '../../lib/code-highlighter';

interface Props {
  code: string;
  /** 围栏语言标注（空串 = 无语言） */
  lang: string;
  /** 流式性能保护：true 时不做高亮 */
  deferHighlight?: boolean;
}

export function CodeBlock({ code, lang, deferHighlight }: Props) {
  const [html, setHtml] = useState<string | undefined>(undefined);
  const trimmedLang = lang.trim();
  // shell 类在 highlightCode 内部返回 undefined；这里提前短路避免无谓调用
  const wantsHighlight = trimmedLang !== '' && !deferHighlight && !['bash', 'sh', 'zsh', 'shell', 'console'].includes(trimmedLang.toLowerCase());

  useEffect(() => {
    setHtml(undefined);
    if (!wantsHighlight) return;
    let cancelled = false;
    void highlightCode(code, trimmedLang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, trimmedLang, wantsHighlight]);

  return (
    <div className="md-codeblock my-2 overflow-hidden rounded-lg border border-subtle bg-surface-1">
      {trimmedLang !== '' && (
        <div className="border-b border-subtle px-3 py-1 font-mono text-[11px] text-tertiary">
          {trimmedLang}
        </div>
      )}
      {html !== undefined ? (
        <div className="md-codeblock-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-codeblock-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
