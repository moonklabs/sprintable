'use client';

import { useState, useEffect, useCallback } from 'react';
import { Node, Mark, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from '@tiptap/react';

// ─── KaTeX Renderer ───────────────────────────────────────────────────────────

async function renderKatex(latex: string, displayMode: boolean): Promise<{ html: string; error?: string }> {
  try {
    const katex = await import('katex');
    const html = katex.default.renderToString(latex, {
      displayMode,
      throwOnError: true,
      output: 'html',
    });
    return { html };
  } catch (err) {
    return { html: '', error: err instanceof Error ? err.message : 'KaTeX 렌더링 실패' };
  }
}

// ─── Math Block View (display mode) ──────────────────────────────────────────

function MathBlockView({ node, selected }: ReactNodeViewProps) {
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
      const { html: rendered, error: err } = await renderKatex(latex, true);
      if (cancelled) return;
      if (err) { setError(err); setHtml(''); } else { setHtml(rendered); setError(''); }
    })();
    return () => { cancelled = true; };
  }, [latex]);

  return (
    <NodeViewWrapper as="div" className="my-4 not-prose">
      <div className="rounded-xl border border-border bg-muted/10">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2" contentEditable={false}>
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--operator-muted)]">math</span>
          {selected && (
            <span className="text-[11px] text-[color:var(--operator-muted)]">LaTeX 편집 중</span>
          )}
        </div>

        {/* LaTeX editor — visible when selected */}
        <pre className={`border-t border-border/50 p-4 text-[13px] leading-6 text-[color:var(--operator-foreground)] font-mono ${showEdit ? '' : 'hidden'}`}>
          <NodeViewContent />
        </pre>

        {/* KaTeX preview */}
        {!showEdit && (
          <div className="px-4 pb-4" contentEditable={false}>
            {error ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400 font-mono">{error}</div>
            ) : html ? (
              <div
                dangerouslySetInnerHTML={{ __html: html }}
                className="flex justify-center overflow-x-auto [&_.katex]:text-[color:var(--operator-foreground)]"
              />
            ) : (
              <p className="text-xs text-[color:var(--operator-muted)] text-center">수식을 입력하세요 (LaTeX)</p>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ─── Math Inline View ────────────────────────────────────────────────────────

function MathInlineView({ node }: ReactNodeViewProps) {
  const latex = node.textContent;
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!latex.trim()) return;
    let cancelled = false;
    void renderKatex(latex, false).then(({ html: rendered, error: err }) => {
      if (cancelled) return;
      if (err) { setError(err); setHtml(''); } else { setHtml(rendered); setError(''); }
    });
    return () => { cancelled = true; };
  }, [latex]);

  if (error) {
    return (
      <NodeViewWrapper as="span" className="rounded bg-red-500/10 px-1 text-xs text-red-400 font-mono">
        {latex}
      </NodeViewWrapper>
    );
  }

  if (html) {
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        <span
          dangerouslySetInnerHTML={{ __html: html }}
          className="[&_.katex]:text-[color:var(--operator-foreground)]"
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="rounded bg-muted/40 px-1 font-mono text-[0.9em]">
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
    return [{ tag: 'div[data-type="mathBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const latex = (HTMLAttributes as Record<string, unknown>)['data-latex'] as string ?? '';
    return ['div', mergeAttributes({ 'data-type': 'mathBlock', 'data-latex': latex }, HTMLAttributes), 0];
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
