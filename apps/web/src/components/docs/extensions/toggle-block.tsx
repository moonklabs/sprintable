'use client';

import { useState, useCallback, useEffect } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from '@tiptap/react';
import { ChevronRight, ChevronDown } from 'lucide-react';

// ─── Toggle Summary View ──────────────────────────────────────────────────────

function ToggleSummaryView({ getPos, editor }: ReactNodeViewProps) {
  const readParentOpen = useCallback((): boolean => {
    if (typeof getPos !== 'function') return false;
    try {
      const pos = getPos();
      if (pos === undefined) return false;
      const $pos = editor.state.doc.resolve(pos);
      if ($pos.depth >= 1) {
        const parent = $pos.node($pos.depth - 1);
        if (parent.type.name === 'toggleBlock') return Boolean(parent.attrs.open);
      }
    } catch { /* node may be deleted */ }
    return false;
  }, [editor, getPos]);

  const [isOpen, setIsOpen] = useState(() => readParentOpen());

  useEffect(() => {
    const updateOpen = () => { setIsOpen(readParentOpen()); };
    editor.on('update', updateOpen);
    return () => { editor.off('update', updateOpen); };
  }, [editor, readParentOpen]);

  const handleToggle = useCallback(() => {
    if (typeof getPos !== 'function') return;
    try {
      const pos = getPos();
      if (pos === undefined) return;
      const $pos = editor.state.doc.resolve(pos);
      if ($pos.depth < 1) return;
      const parentPos = $pos.before($pos.depth);
      const parent = $pos.node($pos.depth - 1);
      if (parent.type.name !== 'toggleBlock') return;
      editor.commands.command(({ tr }) => {
        tr.setNodeMarkup(parentPos, undefined, { open: !parent.attrs.open });
        return true;
      });
    } catch { /* node may be deleted */ }
  }, [editor, getPos]);

  return (
    <NodeViewWrapper as="div" className="flex items-center gap-1.5">
      <button
        type="button"
        contentEditable={false}
        onClick={handleToggle}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={isOpen ? '접기' : '펼치기'}
      >
        {isOpen
          ? <ChevronDown className="size-3.5" />
          : <ChevronRight className="size-3.5" />}
      </button>
      <NodeViewContent as="div" className="flex-1 font-medium leading-6 outline-none" />
    </NodeViewWrapper>
  );
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

export const ToggleSummary = Node.create({
  name: 'toggleSummary',
  content: 'inline*',

  parseHTML() {
    return [{ tag: 'div[data-type="toggleSummary"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'toggleSummary' }, HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleSummaryView);
  },
});

export const ToggleContent = Node.create({
  name: 'toggleContent',
  content: 'block+',

  parseHTML() {
    return [{ tag: 'div[data-type="toggleContent"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'toggleContent' }, HTMLAttributes), 0];
  },
});

export const ToggleBlock = Node.create({
  name: 'toggleBlock',
  group: 'block',
  content: 'toggleSummary toggleContent',
  defining: true,

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-open') === 'true',
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-open': String(attributes['open'] ?? false),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toggleBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'toggleBlock' }, HTMLAttributes), 0];
  },
});
