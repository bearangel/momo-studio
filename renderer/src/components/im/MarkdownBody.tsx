// renderer/src/components/im/MarkdownBody.tsx
//
// 消息正文统一渲染入口（spec 方案二收敛点）：MessageBubble / AgentStreamBubble /
// SubAgentSection / ThinkingSection 四处调用点共用——SafeAnchor 链接拦截、
// CodeBlock 代码块、表格滚动容器全调用点一致，杜绝「修了这处漏那处」。
//
// 块级/行内 code 判定：覆写 pre 组件（块级代码由 CodeBlock 接管，直接消费
// hast 节点），code 组件只对行内代码生效——规避 react-markdown v10 移除
// inline prop 后的 className 误判问题。
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import type { Element } from 'hast';
import { CodeBlock } from './CodeBlock';

/**
 * S2 链接拦截：统一 preventDefault + window.open → 主进程 setWindowOpenHandler
 * 拒绝新窗口并转 shell.openExternal 走系统浏览器。
 */
export function SafeAnchor(props: AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  const { href, children, target: _target, rel: _rel, onClick: _onClick, ...rest } = props;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (typeof href === 'string' && href.length > 0) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...rest}>
      {children as ReactNode}
    </a>
  );
}

/** 从 hast 节点递归提取纯文本 */
function hastText(node: Element): string {
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.value;
    else if (child.type === 'element') out += hastText(child);
  }
  return out;
}

/** 从 pre 的 hast 节点提取 code 子元素的语言标注与代码文本 */
function extractCode(node: Element): { code: string; lang: string } {
  const codeEl = node.children.find(
    (c): c is Element => c.type === 'element' && c.tagName === 'code',
  );
  if (codeEl === undefined) return { code: hastText(node), lang: '' };
  const cls = codeEl.properties?.className;
  const langClass = Array.isArray(cls)
    ? cls.find((c): c is string => typeof c === 'string' && c.startsWith('language-'))
    : undefined;
  return {
    code: hastText(codeEl),
    lang: langClass !== undefined ? langClass.slice('language-'.length) : '',
  };
}

interface Props {
  children: string;
  /** 流式性能保护：true 时代码块纯文本渲染（流式中的活跃段传 true） */
  deferHighlight?: boolean;
}

export function MarkdownBody({ children, deferHighlight }: Props) {
  const components: Components = {
    a: SafeAnchor,
    pre: ({ node }) => {
      if (node === undefined) return <pre>{children}</pre>;
      const { code, lang } = extractCode(node);
      return <CodeBlock code={code.replace(/\n$/, '')} lang={lang} deferHighlight={deferHighlight} />;
    },
    table: ({ children: tableChildren }) => (
      <div className="md-table-wrap">
        <table>{tableChildren}</table>
      </div>
    ),
  };
  return (
    <div className="md-body overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
