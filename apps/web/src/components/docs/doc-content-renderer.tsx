'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, ReactNode, RefObject } from 'react';
import { getShikiHighlighter, resolveLanguage } from './lib/shiki-highlighter';
import { detectEmbedService } from './extensions/embed-node';
import { renderKatex } from './extensions/math-node';
import { renderMermaid } from './lib/mermaid-renderer';
import ReactMarkdown from 'react-markdown';
import DOMPurify from 'dompurify';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import NextImage from 'next/image';
import { cn } from '@/lib/utils';
import { extractDocHeadings, slugifyHeading } from './doc-heading-utils';

interface DocContentRendererProps {
  content: string;
  contentFormat?: 'markdown' | 'html';
  className?: string;
  contentRef?: RefObject<HTMLDivElement | null>;
  codeCopyLabel?: string;
  codeCopiedLabel?: string;
  /** Public share viewer — render internal doc links as plain text (no navigation/traversal). */
  publicMode?: boolean;
  /** publicMode placeholder text for auth-gated attachments that can't render publicly. */
  publicAttachmentLabel?: string;
  /** publicMode placeholder text for auth-gated images that can't render publicly. */
  publicImageLabel?: string;
}

export function DocContentRenderer({
  content,
  contentFormat = 'markdown',
  className,
  contentRef,
  codeCopyLabel = 'Copy',
  codeCopiedLabel = 'Copied',
  publicMode = false,
  publicAttachmentLabel = 'Attachment unavailable in public view',
  publicImageLabel = 'Image unavailable in public view',
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

    // HTML format code blocks: apply Shiki highlighting via DOM
    if (contentFormat === 'html') {
      const preTags = Array.from(root.querySelectorAll<HTMLPreElement>('pre'));
      preTags.forEach((pre) => {
        const codeEl = pre.querySelector('code');
        const text = codeEl?.textContent ?? pre.textContent ?? '';
        if (!text.trim()) return;
        const lang = codeEl?.className.replace('language-', '').split(' ')[0]
          ?? pre.getAttribute('data-language')
          ?? null;
        void getShikiHighlighter().then((shiki) => {
          const highlighted = shiki.codeToHtml(text, {
            lang: resolveLanguage(lang),
            theme: 'dark-plus',
          });
          const wrapper = document.createElement('div');
          wrapper.innerHTML = highlighted;
          wrapper.className = '[&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:text-xs [&_pre]:leading-6 [&_code]:!bg-transparent overflow-x-auto';
          if (pre.parentElement) pre.replaceWith(wrapper);
        }).catch(() => { /* fallback: keep original pre */ });
      });
    }

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

    // Wiki link click handlers (viewer)
    const wikiLinks = Array.from(root.querySelectorAll<HTMLElement>('[data-type="wikiLink"]'));
    const wikiCleanup = wikiLinks.map((span) => {
      const slug = span.getAttribute('data-slug') ?? '';
      const title = span.getAttribute('data-title') ?? span.textContent ?? '';
      // Public share viewer: internal doc links are inert plain text — no navigation,
      // no cross-doc traversal (meta-leak guard).
      if (publicMode) {
        span.className = 'text-sm text-muted-foreground';
        span.removeAttribute('data-slug');
        return () => { /* no handler attached */ };
      }
      span.className = 'inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-sm text-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground';
      span.title = title;
      const handleClick = () => { if (slug) window.location.href = `/docs/${slug}`; };
      span.addEventListener('click', handleClick);
      return () => span.removeEventListener('click', handleClick);
    });

    // Math block rendering (viewer)
    const mathBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-type="mathBlock"]'));
    mathBlocks.forEach((block) => {
      const latex = block.getAttribute('data-latex') ?? block.textContent ?? '';
      if (!latex.trim()) return;
      void renderKatex(latex, true).then(({ html: katexHtml, error }) => {
        if (error) {
          block.innerHTML = `<div class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive font-mono">${escapeHtmlText(error)}</div>`;
        } else {
          block.innerHTML = `<div class="flex justify-center overflow-x-auto py-3 [&_.katex]:text-foreground">${katexHtml}</div>`;
        }
      });
    });

    const mathInlines = Array.from(root.querySelectorAll<HTMLElement>('[data-type="mathInline"]'));
    mathInlines.forEach((span) => {
      const latex = span.textContent ?? '';
      if (!latex.trim()) return;
      void renderKatex(latex, false).then(({ html: katexHtml, error }) => {
        if (error) {
          span.className = 'rounded bg-destructive/10 px-1 text-xs text-destructive font-mono';
        } else {
          span.innerHTML = katexHtml;
        }
      });
    });

    // Embed block handlers (viewer)
    const embedBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-type="embedBlock"]'));
    embedBlocks.forEach((block) => {
      const url = block.getAttribute('data-url') ?? '';
      if (!url) return;
      const { type, embedUrl } = detectEmbedService(url);
      block.innerHTML = '';
      if (type === 'youtube') {
        const wrapper = document.createElement('div');
        wrapper.className = 'aspect-video w-full overflow-hidden rounded-xl border border-border';
        const iframe = document.createElement('iframe');
        iframe.src = embedUrl;
        iframe.title = 'YouTube video';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.className = 'h-full w-full';
        wrapper.appendChild(iframe);
        block.appendChild(wrapper);
      } else if (type === 'figma') {
        const wrapper = document.createElement('div');
        wrapper.className = 'h-[480px] w-full overflow-hidden rounded-xl border border-border';
        const iframe = document.createElement('iframe');
        iframe.src = embedUrl;
        iframe.title = 'Figma embed';
        iframe.allow = 'fullscreen';
        iframe.allowFullscreen = true;
        iframe.className = 'h-full w-full';
        wrapper.appendChild(iframe);
        block.appendChild(wrapper);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'flex items-center gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm transition-colors hover:bg-muted/40 no-underline';
        a.textContent = url;
        block.appendChild(a);
      }
    });

    // File attachment download handlers (viewer)
    const fileBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-type="fileAttachment"]'));
    const fileCleanup = fileBlocks.map((block) => {
      const filename = block.getAttribute('data-filename') ?? 'file';
      const data = block.getAttribute('data-file-data') ?? '';
      const size = Number(block.getAttribute('data-size') ?? 0);
      const sizeLabel = size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / (1024 * 1024)).toFixed(1)} MB`;

      // Public share viewer: attachments are auth-gated (private bucket + signed URL),
      // so they'd 401 here — render an inert placeholder (no leak, no broken render).
      if (publicMode) {
        block.innerHTML = `
          <div class="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20 px-4 py-3 opacity-70">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0 text-muted-foreground"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">${escapeHtmlText(filename)}</p>
              <p class="text-xs opacity-60">${escapeHtmlText(publicAttachmentLabel)}</p>
            </div>
          </div>`;
        return () => {};
      }

      block.innerHTML = `
        <div class="flex items-center gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20 px-4 py-3 cursor-pointer hover:bg-[hsl(var(--muted))]/40 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0 text-muted-foreground"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">${escapeHtmlText(filename)}</p>
            <p class="text-xs opacity-60">${escapeHtmlText(sizeLabel)}</p>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0 opacity-50"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>`;

      const handleClick = () => {
        if (!data) return;
        const a = document.createElement('a');
        a.href = data;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };
      block.addEventListener('click', handleClick);
      return () => block.removeEventListener('click', handleClick);
    });

    // Public share viewer: images may point to auth-gated resources (401) — replace
    // each with an inert placeholder (real public images are post-MVP).
    if (publicMode) {
      Array.from(root.querySelectorAll<HTMLImageElement>('img')).forEach((img) => {
        const alt = img.getAttribute('alt')?.trim();
        const placeholder = document.createElement('div');
        placeholder.className = 'flex items-center gap-2 rounded-xl border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground';
        placeholder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0"><path d="m2 2 20 20"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" y1="13.5" x2="6" y2="21"/><line x1="18" y1="12" x2="21" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.05-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg><span class="truncate">${escapeHtmlText(alt || publicImageLabel)}</span>`;
        img.replaceWith(placeholder);
      });
    }

    // Toggle block click handlers (viewer)
    const toggleSummaries = Array.from(root.querySelectorAll<HTMLElement>('[data-type="toggleSummary"]'));
    const toggleCleanup = toggleSummaries.map((summary) => {
      const handleClick = () => {
        const block = summary.closest<HTMLElement>('[data-type="toggleBlock"]');
        if (!block) return;
        const isOpen = block.getAttribute('data-open') === 'true';
        block.setAttribute('data-open', String(!isOpen));
      };
      summary.addEventListener('click', handleClick);
      return () => summary.removeEventListener('click', handleClick);
    });

    return () => {
      cleanup.forEach((dispose) => dispose());
      wikiCleanup.forEach((dispose) => dispose());
      fileCleanup.forEach((dispose) => dispose());
      toggleCleanup.forEach((dispose) => dispose());
    };
  }, [codeCopiedLabel, codeCopyLabel, content, contentFormat, publicMode, publicAttachmentLabel, publicImageLabel]);

  const decoratedHtml = useMemo(() => {
    const sanitized = sanitizeDocHtml(content);
    if (contentFormat !== 'html') return sanitized;
    return decorateHtmlContent(sanitized, headings, codeCopyLabel);
  }, [codeCopyLabel, content, contentFormat, headings]);

  const rootClassName = cn(
    'doc-renderer prose dark:prose-invert prose-sm max-w-none text-foreground',
    '[&_h1]:scroll-mt-24 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight',
    '[&_h2]:scroll-mt-24 [&_h2]:mt-10 [&_h2]:text-2xl [&_h2]:font-semibold',
    '[&_h3]:scroll-mt-24 [&_h3]:mt-8 [&_h3]:text-xl [&_h3]:font-semibold',
    '[&_p]:leading-7 [&_p]:text-foreground/92',
    '[&_a]:text-[color:var(--brand-soft)] [&_a]:underline [&_a]:underline-offset-4',
    '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:bg-muted/30 [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:text-muted-foreground',
    '[&_img]:max-h-[32rem] [&_img]:w-full [&_img]:rounded-xl [&_img]:border [&_img]:border-border [&_img]:object-contain',
    '[&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-xl [&_table]:border [&_table]:border-border [&_table]:bg-muted/20',
    '[&_thead]:bg-muted/50 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
    '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2',
    '[&_hr]:my-8 [&_hr]:border-border',
    '[&_ul]:space-y-2 [&_ol]:space-y-2',
    '[&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:text-foreground [&_pre]:p-4 [&_pre]:text-xs [&_pre]:leading-6',
    '[&_code]:rounded-md [&_code]:bg-muted [&_code]:text-foreground [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm',
    '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
    '[&_[data-doc-code-shell="true"]]:not-prose [&_[data-doc-code-shell="true"]]:my-6',
    '[&_[data-doc-code-actions="true"]]:mb-2 [&_[data-doc-code-actions="true"]]:flex [&_[data-doc-code-actions="true"]]:justify-end',
    '[&_[data-doc-copy-button="true"]]:rounded-md [&_[data-doc-copy-button="true"]]:border [&_[data-doc-copy-button="true"]]:border-border [&_[data-doc-copy-button="true"]]:bg-card [&_[data-doc-copy-button="true"]]:px-3 [&_[data-doc-copy-button="true"]]:py-1.5 [&_[data-doc-copy-button="true"]]:text-[11px] [&_[data-doc-copy-button="true"]]:font-medium [&_[data-doc-copy-button="true"]]:text-muted-foreground',
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
          img: ({ src, alt }) => <NextImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} width={800} height={600} style={{ maxWidth: '100%', height: 'auto' }} unoptimized />,
          table: ({ children }) => (
            <div className="not-prose overflow-x-auto rounded-xl border border-border">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => <>{children}</>,
          code: (props) => {
            const { children, className: codeClassName } = props as { children?: ReactNode; className?: string };
            const childText = Array.isArray(children) ? children.join('') : String(children ?? '');
            const inline = !String(codeClassName ?? '').includes('language-') && !childText.includes('\n');
            if (!inline) {
              const lang = String(codeClassName ?? '').replace('language-', '') || null;
              if (lang === 'mermaid') {
                return <MermaidReadonlyBlock code={childText} />;
              }
              return (
                <ShikiCodeBlock
                  code={childText}
                  language={lang}
                  copyLabel={codeCopyLabel}
                  copiedLabel={codeCopiedLabel}
                />
              );
            }
            return <code>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MermaidReadonlyBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code.trim()) return;
    let cancelled = false;
    void renderMermaid(code).then(({ svg: rendered }) => {
      if (!cancelled) { setSvg(rendered); setError(''); }
    }).catch((err: unknown) => {
      if (!cancelled) { setError(err instanceof Error ? err.message : '렌더링 실패'); setSvg(''); }
    });
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return <div className="not-prose my-4 rounded-xl border border-destructive-border bg-destructive-tint p-3 text-xs text-destructive">{error}</div>;
  }
  if (!svg) {
    return <div className="not-prose my-4 rounded-xl border border-border bg-muted p-4 text-xs text-muted-foreground">렌더링 중...</div>;
  }
  return (
    <div
      className="not-prose my-4 flex justify-center rounded-xl border border-border bg-muted p-4 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function ShikiCodeBlock({
  code, language, copyLabel, copiedLabel,
}: {
  code: string;
  language: string | null;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [html, setHtml] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!code.trim()) return;
    let cancelled = false;
    void (async () => {
      try {
        const shiki = await getShikiHighlighter();
        if (cancelled) return;
        const lang = resolveLanguage(language);
        setHtml(shiki.codeToHtml(code, { lang, theme: 'dark-plus' }));
      } catch { /* fallback to plain */ }
    })();
    return () => { cancelled = true; };
  }, [code, language]);

  const handleCopy = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
    } catch { /* unavailable */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [code]);

  return (
    <div data-doc-code-shell="true" className="not-prose my-6 overflow-hidden rounded-xl border border-border bg-muted">
      <div data-doc-code-actions="true" className="flex justify-end px-3 pt-2">
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      {html ? (
        <div
          dangerouslySetInnerHTML={{ __html: html }}
          className="overflow-x-auto [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:p-4 [&_pre]:text-xs [&_pre]:leading-6 [&_code]:!bg-transparent"
        />
      ) : (
        <pre className="overflow-x-auto p-4 text-xs leading-6 text-foreground">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function sanitizeDocHtml(content: string): string {
  const maybePurifier = DOMPurify as unknown as {
    sanitize?: (value: string) => string;
    default?: { sanitize?: (value: string) => string };
  };

  const sanitize = maybePurifier.sanitize ?? maybePurifier.default?.sanitize;
  return sanitize ? sanitize(content) : '';
}

function decorateHtmlContent(content: string, headings: ReturnType<typeof extractDocHeadings>, codeCopyLabel: string): string {
  let headingIndex = 0;

  const withHeadingIds = content.replace(/<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, level, attrs, inner) => {
    const heading = headings[headingIndex++];
    if (!heading) return match;

    return `<h${level} id="${escapeHtmlAttribute(heading.id)}">${sanitizeHeadingInner(inner)}</h${level}>`;
  });

  const withTableShells = withHeadingIds.replace(/<table\b[\s\S]*?<\/table>/gi, (tableMarkup) => {
    return `<div class="not-prose overflow-x-auto rounded-xl border border-border">${tableMarkup}</div>`;
  });

  return withTableShells.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_match, inner) => {
    return [
      '<div data-doc-code-shell="true">',
      '<div data-doc-code-actions="true">',
      `<button type="button" data-doc-copy-button="true" class="transition hover:border-brand/35 hover:text-foreground">${escapeHtmlText(codeCopyLabel)}</button>`,
      '</div>',
      `<pre>${inner}</pre>`,
      '</div>',
    ].join('');
  });
}

// Safe inline tags that may appear inside headings (no attributes — prevents event handler injection)
const SAFE_HEADING_TAG_RE = /^<\/?(strong|em|code|b|i|s|del|ins|mark|sup|sub)>$/i;

function sanitizeHeadingInner(inner: string): string {
  return inner.replace(/<[^>]+>/g, (tag) => {
    if (SAFE_HEADING_TAG_RE.test(tag)) return tag;
    return escapeHtmlText(tag);
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

