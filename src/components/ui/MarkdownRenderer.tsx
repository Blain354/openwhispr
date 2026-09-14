import type { ReactElement } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// Stable component types preserve DOM state, including table scroll positions.
const markdownComponents: Components = {
  h1: ({ children }): ReactElement => (
    <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }): ReactElement => (
    <h2 className="text-base font-semibold mb-2 mt-3 first:mt-0">{children}</h2>
  ),
  h3: ({ children }): ReactElement => (
    <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0">{children}</h3>
  ),
  p: ({ children }): ReactElement => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }): ReactElement => <ul className="list-disc ps-4 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }): ReactElement => (
    <ol className="list-decimal ps-4 mb-2 space-y-1">{children}</ol>
  ),
  li: ({ children }): ReactElement => <li className="ps-1">{children}</li>,
  a: ({ href, children }): ReactElement => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link underline decoration-link/30 hover:decoration-link/60 transition-colors"
    >
      {children}
    </a>
  ),
  code: ({ children }): ReactElement => (
    <code dir="ltr" className="bg-black/10 px-1 py-0.5 rounded text-xs font-mono">
      {children}
    </code>
  ),
  pre: ({ children }): ReactElement => (
    <pre dir="ltr" className="bg-black/10 p-2 rounded overflow-x-auto text-xs mb-2">
      {children}
    </pre>
  ),
  strong: ({ children }): ReactElement => <strong className="font-semibold">{children}</strong>,
  em: ({ children }): ReactElement => <em className="italic">{children}</em>,
  blockquote: ({ children }): ReactElement => (
    <blockquote className="border-s-2 border-current/30 ps-3 italic my-2">{children}</blockquote>
  ),
  hr: (): ReactElement => <hr className="border-current/20 my-3" />,
  table: ({ children }): ReactElement => (
    <div className="overflow-x-auto mb-2">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }): ReactElement => (
    <thead className="border-b border-current/20">{children}</thead>
  ),
  tr: ({ children }): ReactElement => (
    <tr className="border-b border-current/10 last:border-0">{children}</tr>
  ),
  // style carries the GFM column alignment (:--, :-:, --:).
  th: ({ children, style }): ReactElement => (
    <th style={style} className="px-2 py-1.5 text-start font-semibold align-top">
      {children}
    </th>
  ),
  td: ({ children, style }): ReactElement => (
    <td style={style} className="px-2 py-1.5 align-top">
      {children}
    </td>
  ),
};

export function MarkdownRenderer({ content, className }: MarkdownRendererProps): ReactElement {
  return (
    <div dir="auto" className={className}>
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </Markdown>
    </div>
  );
}

export default MarkdownRenderer;
