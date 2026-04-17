'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, ReactNode, RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import DOMPurify from 'dompurify';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '@/lib/utils';
import { extractDocHeadings, slugifyHeading } from './doc-heading-utils';

interface DocContentRendererProps {
  content: string;
  contentFormat?: 'markdown' | 'html';
  className?: string;
  contentRef?: RefObject<HTMLDivElement | null>;
  codeCopyLabel?: string;
  codeCopiedLabel?: string;
}

export function DocContentRenderer({
  content,
  contentFormat = 'markdown',
  className,
  contentRef,
  codeCopyLabel = 'Copy',
  codeCopiedLabel = 'Copied',
}: DocContentRendererProps) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const headings = useMemo(() => extractDocHeadings(content, contentFormat), [content, contentFormat]);

  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    internalRef.current = node;

    if (!contentRef) return;
    (contentRef as MutableRefObject<HTMLDivElement | null>).current = node;
  }, [contentRef]);

  useEffect(() => {
    const root = internalRef.current;
    if (!root) return;

    const headingCounts = new Map<string, number>();
    Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3')).forEach((heading) => {
      const baseId = slugifyHeading(heading.textContent ?? '');
      const seen = headingCounts.get(baseId) ?? 0;
      headingCounts.set(baseId, seen + 1);
      heading.id = seen === 0 ? baseId : `${baseId}-${seen + 1}`;
    });

    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-doc-copy-button="true"]'));
    const cleanup = buttons.map((button) => {
      const handleClick = async () => {
        const shell = button.closest<HTMLElement>('[data-doc-code-shell="true"]');
        const pre = shell?.querySelector('pre');
        const text = pre?.textContent ?? '';

        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
          }
          button.textContent = codeCopiedLabel;
          window.setTimeout(() => {
            button.textContent = codeCopyLabel;
          }, 1600);
        } catch {
          button.textContent = codeCopiedLabel;
          window.setTimeout(() => {
            button.textContent = codeCopyLabel;
          }, 1600);
        }
      };

      button.addEventListener('click', handleClick);
      return () => button.removeEventListener('click', handleClick);
    });

    return () => {
      cleanup.forEach((dispose) => dispose());
    };
  }, [codeCopiedLabel, codeCopyLabel, content, contentFormat]);

  const decoratedHtml = useMemo(() => {
    const sanitized = sanitizeDocHtml(content);
    if (contentFormat !== 'html') return sanitized;
    return decorateHtmlContent(sanitized, headings, codeCopyLabel);
  }, [codeCopyLabel, content, contentFormat, headings]);

  const rootClassName = cn(
    'doc-renderer prose prose-invert prose-sm max-w-none text-[color:var(--operator-foreground)]',
    '[&_h1]:scroll-mt-24 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight',
    '[&_h2]:scroll-mt-24 [&_h2]:mt-10 [&_h2]:text-2xl [&_h2]:font-semibold',
    '[&_h3]:scroll-mt-24 [&_h3]:mt-8 [&_h3]:text-xl [&_h3]:font-semibold',
    '[&_p]:leading-7 [&_p]:text-[color:var(--operator-foreground)]/92',
    '[&_a]:text-[color:var(--operator-primary-soft)] [&_a]:underline [&_a]:underline-offset-4',
    '[&_blockquote]:rounded-2xl [&_blockquote]:border-l-4 [&_blockquote]:border-[color:var(--operator-primary)]/45 [&_blockquote]:bg-[color:var(--operator-primary)]/8 [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:text-[color:var(--operator-foreground)]/88',
    '[&_img]:max-h-[32rem] [&_img]:w-full [&_img]:rounded-2xl [&_img]:border [&_img]:border-white/10 [&_img]:object-contain',
    '[&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-2xl [&_table]:border [&_table]:border-white/10 [&_table]:bg-black/10',
    '[&_thead]:bg-white/6 [&_th]:border [&_th]:border-white/10 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
    '[&_td]:border [&_td]:border-white/10 [&_td]:px-3 [&_td]:py-2',
    '[&_hr]:my-8 [&_hr]:border-white/10',
    '[&_ul]:space-y-2 [&_ol]:space-y-2',
    '[&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:border [&_pre]:border-white/10 [&_pre]:bg-[#0b1120] [&_pre]:p-4 [&_pre]:text-[13px] [&_pre]:leading-6',
    '[&_code]:rounded-md [&_code]:bg-white/10 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.95em]',
    '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
    '[&_[data-doc-code-shell="true"]]:not-prose [&_[data-doc-code-shell="true"]]:my-6',
    '[&_[data-doc-code-actions="true"]]:mb-2 [&_[data-doc-code-actions="true"]]:flex [&_[data-doc-code-actions="true"]]:justify-end',
    '[&_[data-doc-copy-button="true"]]:rounded-full [&_[data-doc-copy-button="true"]]:border [&_[data-doc-copy-button="true"]]:border-white/12 [&_[data-doc-copy-button="true"]]:bg-white/8 [&_[data-doc-copy-button="true"]]:px-3 [&_[data-doc-copy-button="true"]]:py-1.5 [&_[data-doc-copy-button="true"]]:text-[11px] [&_[data-doc-copy-button="true"]]:font-medium [&_[data-doc-copy-button="true"]]:uppercase [&_[data-doc-copy-button="true"]]:tracking-[0.18em] [&_[data-doc-copy-button="true"]]:text-[color:var(--operator-muted)]',
    className,
  );

  if (contentFormat === 'html') {
    return (
      <div
        ref={setContentRef}
        dangerouslySetInnerHTML={{ __html: decoratedHtml }}
        className={rootClassName}
      />
    );
  }

  let headingIndex = 0;

  return (
    <div ref={setContentRef} className={rootClassName}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          h1: ({ children }) => {
            const heading = headings[headingIndex++];
            return <h1 id={heading?.id}>{children}</h1>;
          },
          h2: ({ children }) => {
            const heading = headings[headingIndex++];
            return <h2 id={heading?.id}>{children}</h2>;
          },
          h3: ({ children }) => {
            const heading = headings[headingIndex++];
            return <h3 id={heading?.id}>{children}</h3>;
          },
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          img: ({ src, alt }) => <img src={src ?? ''} alt={alt ?? ''} loading="lazy" />, 
          table: ({ children }) => (
            <div className="not-prose overflow-x-auto rounded-2xl border border-white/10">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => (
            <div data-doc-code-shell="true">
              <div data-doc-code-actions="true">
                <button
                  type="button"
                  data-doc-copy-button="true"
                  className="transition hover:border-[color:var(--operator-primary)]/35 hover:text-[color:var(--operator-foreground)]"
                >
                  {codeCopyLabel}
                </button>
              </div>
              <pre>{children}</pre>
            </div>
          ),
          code: (props) => {
            const { children, className: codeClassName } = props as { children?: ReactNode; className?: string };
            const childText = Array.isArray(children) ? children.join('') : String(children ?? '');
            const inline = !String(codeClassName ?? '').includes('language-') && !childText.includes('\n');
            return inline ? <code>{children}</code> : <code className={codeClassName}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function sanitizeDocHtml(content: string): string {
  const maybePurifier = DOMPurify as unknown as {
    sanitize?: (value: string) => string;
    default?: { sanitize?: (value: string) => string };
  };

  const sanitize = maybePurifier.sanitize ?? maybePurifier.default?.sanitize;
  return sanitize ? sanitize(content) : content;
}

function decorateHtmlContent(content: string, headings: ReturnType<typeof extractDocHeadings>, codeCopyLabel: string): string {
  let headingIndex = 0;

  const withHeadingIds = content.replace(/<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, level, attrs, inner) => {
    const heading = headings[headingIndex++];
    if (!heading) return match;

    const withoutId = String(attrs).replace(/\s+id=(['"]).*?\1/i, '');
    return `<h${level}${withoutId} id="${escapeHtmlAttribute(heading.id)}">${inner}</h${level}>`;
  });

  const withTableShells = withHeadingIds.replace(/<table\b[\s\S]*?<\/table>/gi, (tableMarkup) => {
    return `<div class="not-prose overflow-x-auto rounded-2xl border border-white/10">${tableMarkup}</div>`;
  });

  return withTableShells.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_match, inner) => {
    return [
      '<div data-doc-code-shell="true">',
      '<div data-doc-code-actions="true">',
      `<button type="button" data-doc-copy-button="true" class="transition hover:border-[color:var(--operator-primary)]/35 hover:text-[color:var(--operator-foreground)]">${escapeHtmlText(codeCopyLabel)}</button>`,
      '</div>',
      `<pre>${inner}</pre>`,
      '</div>',
    ].join('');
  });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

