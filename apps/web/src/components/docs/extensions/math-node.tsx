'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Node, mergeAttributes } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from '@tiptap/react';

// ─── KaTeX Renderer ───────────────────────────────────────────────────────────

async function renderKatex(latex: string, displayMode: boolean, fallbackError: string): Promise<{ html: string; error?: string }> {
  try {
    const katex = await import('katex');
    const html = katex.default.renderToString(latex, {
      displayMode,
      throwOnError: true,
      output: 'html',
      // story #4338 — 문서 글쓴이 입력이라 링크 · 임의 HTML 명령(`\href` · `\url` · `\htmlClass` 등)을 믿지 않는다. 기본값이 false여도
      // 기본값에 기대지 않고 적는다(라이브러리 기본이 바뀌어도 이 자리는 그대로).
      trust: false,
    });
    return { html };
  } catch (err) {
    return { html: '', error: err instanceof Error ? err.message : fallbackError };
  }
}

// ─── Math Block View (display mode) ──────────────────────────────────────────

function MathBlockView({ node, selected }: ReactNodeViewProps) {
  const t = useTranslations('docs');
  const latex = node.textContent;
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const showEdit = selected;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!latex.trim()) {
        setHtml('');
        setError('');
        return;
      }
      const { html: rendered, error: err } = await renderKatex(latex, true, t('mathRenderFailed'));
      if (cancelled) return;
      if (err) { setError(err); setHtml(''); } else { setHtml(rendered); setError(''); }
    })();
    return () => { cancelled = true; };
  }, [latex, t]);

  return (
    <NodeViewWrapper as="div" className="my-4 not-prose">
      <div className="rounded-xl border border-border bg-muted/10">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2" contentEditable={false}>
          <span className="text-[11px] font-medium text-muted-foreground">math</span>
          {selected && (
            <span className="text-[11px] text-muted-foreground">{t('mathEditingLatex')}</span>
          )}
        </div>

        {/* LaTeX editor — visible when selected */}
        <pre className={`border-t border-border/50 p-4 text-xs leading-6 text-foreground font-mono ${showEdit ? '' : 'hidden'}`}>
          <NodeViewContent />
        </pre>

        {/* KaTeX preview */}
        {!showEdit && (
          <div className="px-4 pb-4" contentEditable={false}>
            {/* story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙). */}
            {error ? (
              <div
                className="rounded-lg border border-destructive-border bg-destructive-tint p-3 text-xs text-foreground font-mono"
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
              >
                {error}
              </div>
            ) : html ? (
              <div
                dangerouslySetInnerHTML={{ __html: html }}
                className="flex justify-center overflow-x-auto [&_.katex]:text-foreground"
              />
            ) : (
              <p className="text-xs text-muted-foreground text-center">{t('mathPlaceholder')}</p>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ─── Math Inline View ────────────────────────────────────────────────────────

function MathInlineView({ node }: ReactNodeViewProps) {
  const t = useTranslations('docs');
  const latex = node.textContent;
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!latex.trim()) return;
    let cancelled = false;
    void renderKatex(latex, false, t('mathRenderFailed')).then(({ html: rendered, error: err }) => {
      if (cancelled) return;
      if (err) { setError(err); setHtml(''); } else { setHtml(rendered); setError(''); }
    });
    return () => { cancelled = true; };
  }, [latex, t]);

  if (error) {
    return (
      // story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙).
      <NodeViewWrapper as="span" className="rounded bg-destructive-tint px-1 text-xs text-foreground font-mono">
        {latex}
      </NodeViewWrapper>
    );
  }

  if (html) {
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        <span
          dangerouslySetInnerHTML={{ __html: html }}
          className="[&_.katex]:text-foreground"
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="rounded bg-muted/40 px-1 font-mono text-sm">
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

// ─── Node Definitions ─────────────────────────────────────────────────────────

export const MathBlockNode = Node.create({
  name: 'mathBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  parseHTML() {
    // story #4339 — 수식은 노드의 글이 원본이다. 저장 HTML이 `data-latex`만 싣고 글이 비어 있으면(MCP · 렌더러 형식) 그 값을 글로 세운다 —
    // 예전엔 편집기에서 빈 수식 · 저장하면 `data-latex=""`로 수식이 사라졌다.
    return [{
      tag: 'div[data-type="mathBlock"]',
      getContent: (node, schema) => {
        const el = node as HTMLElement;
        const latex = (el.textContent ?? '').trim() ? el.textContent ?? '' : el.getAttribute('data-latex') ?? '';
        return latex ? Fragment.from(schema.text(latex)) : Fragment.empty;
      },
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // `data-latex` = 노드의 글(예전엔 없는 속성을 읽어 늘 ""). 렌더러는 이 값을 먼저 읽고 없으면 글로 되돌아간다.
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'mathBlock', 'data-latex': node.textContent }), 0];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-m': () => this.editor.commands.insertContent({
        type: this.name,
        content: [{ type: 'text', text: '' }],
      }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView);
  },
});

export const MathInlineNode = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  content: 'text*',
  marks: '',

  parseHTML() {
    return [{ tag: 'span[data-type="mathInline"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': 'mathInline' }, HTMLAttributes), 0];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-e': () => this.editor.commands.insertContent({
        type: this.name,
        content: [{ type: 'text', text: '' }],
      }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView);
  },
});

// ─── Viewer helper ────────────────────────────────────────────────────────────

export { renderKatex };
