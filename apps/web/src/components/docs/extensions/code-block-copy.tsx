'use client';

import { useState, useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from '@tiptap/react';

function CodeBlockView({ node }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = node.textContent;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // clipboard unavailable — still show feedback
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [node.textContent]);

  return (
    <NodeViewWrapper className="my-4 not-prose">
      <div className="rounded-2xl border border-slate-700 bg-[#0b1120]">
        <div className="flex justify-end px-3 pt-2">
          <button
            type="button"
            contentEditable={false}
            onClick={handleCopy}
            className="rounded-full border border-slate-600 bg-slate-700/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-300 transition hover:border-slate-400 hover:text-slate-100"
          >
            {copied ? '복사됨' : '복사'}
          </button>
        </div>
        <pre className="overflow-x-auto p-4 text-[13px] leading-6 text-slate-200">
          <NodeViewContent />
        </pre>
      </div>
    </NodeViewWrapper>
  );
}

export const CodeBlockWithCopy = Node.create({
  name: 'codeBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  addAttributes() {
    return {
      language: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-language') ??
          (element.firstElementChild as HTMLElement | null)?.className.replace('language-', '') ??
          null,
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes['language']) return {};
          return {
            'data-language': attributes['language'],
            class: `language-${attributes['language']}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'pre', preserveWhitespace: 'full' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes), ['code', {}, 0]];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-c': () => this.editor.commands.toggleNode(this.name, 'paragraph'),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
