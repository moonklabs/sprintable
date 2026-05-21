'use client';

import { useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from '@tiptap/react';
import { Columns2, Columns3 } from 'lucide-react';

// ─── Columns Block View ───────────────────────────────────────────────────────

function ColumnsBlockView({ node, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  const cols = (node.attrs.columns as number) ?? 2;

  const switchTo = useCallback((target: 2 | 3) => {
    if (typeof getPos !== 'function') return;
    const pos = getPos();
    if (pos === undefined) return;

    if (target === 3 && cols === 2) {
      // Add a new column at the end
      editor.commands.command(({ tr }) => {
        const { schema } = editor;
        const insertPos = pos + node.nodeSize - 1;
        const colNode = schema.nodes['columnBlock']?.create(null, schema.nodes['paragraph']?.create());
        if (!colNode) return false;
        tr.insert(insertPos, colNode);
        tr.setNodeMarkup(pos, undefined, { columns: 3 });
        return true;
      });
    } else if (target === 2 && cols === 3) {
      // Remove last column
      editor.commands.command(({ tr }) => {
        const lastChild = node.lastChild;
        if (!lastChild) return false;
        const lastColEnd = pos + node.nodeSize - 1;
        const lastColStart = lastColEnd - lastChild.nodeSize;
        tr.delete(lastColStart, lastColEnd);
        tr.setNodeMarkup(pos, undefined, { columns: 2 });
        return true;
      });
    } else {
      updateAttributes({ columns: target });
    }
  }, [cols, editor, getPos, node, updateAttributes]);

  const gridClass = cols === 3
    ? 'grid grid-cols-1 sm:grid-cols-3 gap-4'
    : 'grid grid-cols-1 sm:grid-cols-2 gap-4';

  return (
    <NodeViewWrapper as="div" className="not-prose my-4 group">
      {/* Column switcher — visible on hover */}
      <div
        contentEditable={false}
        className="mb-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <span className="text-[10px] uppercase tracking-widest text-[color:var(--operator-muted)] mr-1">컬럼</span>
        <button
          type="button"
          onClick={() => switchTo(2)}
          className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
            cols === 2
              ? 'border-[color:var(--operator-primary)]/40 bg-[color:var(--operator-primary)]/10 text-[color:var(--operator-primary-soft)]'
              : 'border-border text-[color:var(--operator-muted)] hover:border-[color:var(--operator-primary)]/30 hover:text-[color:var(--operator-foreground)]'
          }`}
        >
          <Columns2 className="size-3" />2단
        </button>
        <button
          type="button"
          onClick={() => switchTo(3)}
          className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
            cols === 3
              ? 'border-[color:var(--operator-primary)]/40 bg-[color:var(--operator-primary)]/10 text-[color:var(--operator-primary-soft)]'
              : 'border-border text-[color:var(--operator-muted)] hover:border-[color:var(--operator-primary)]/30 hover:text-[color:var(--operator-foreground)]'
          }`}
        >
          <Columns3 className="size-3" />3단
        </button>
      </div>

      {/* Grid wrapper — NodeViewContent renders columnBlock children directly */}
      <div className={gridClass}>
        <NodeViewContent as="div" className="contents" />
      </div>
    </NodeViewWrapper>
  );
}

// ─── Node Definitions ─────────────────────────────────────────────────────────

export const ColumnBlock = Node.create({
  name: 'columnBlock',
  content: 'block+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="columnBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'columnBlock' }, HTMLAttributes), 0];
  },
});

export const ColumnsBlock = Node.create({
  name: 'columnsBlock',
  group: 'block',
  content: 'columnBlock+',
  defining: true,

  addAttributes() {
    return {
      columns: {
        default: 2,
        parseHTML: (el) => Number(el.getAttribute('data-cols') ?? 2),
        renderHTML: (attributes: Record<string, unknown>) => ({
          'data-cols': String(attributes['columns'] ?? 2),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="columnsBlock"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'columnsBlock' }, HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ColumnsBlockView);
  },
});
