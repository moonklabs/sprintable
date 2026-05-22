'use client';

import { useState, useCallback, useRef } from 'react';
import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';

// ─── Resize Handle ────────────────────────────────────────────────────────────

function ImageView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) ?? '';
  const width = node.attrs.width as number | null;

  const handleResizeStart = useCallback((e: React.MouseEvent, side: 'left' | 'right') => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = imgRef.current?.offsetWidth ?? 300;

    const onMouseMove = (me: MouseEvent) => {
      const delta = me.clientX - startXRef.current;
      const newWidth = Math.max(80, startWidthRef.current + (side === 'right' ? delta : -delta));
      updateAttributes({ width: Math.round(newWidth) });
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [updateAttributes]);

  return (
    <NodeViewWrapper as="div" className="relative my-4 inline-block max-w-full">
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        style={{ width: width ? `${width}px` : undefined, maxWidth: '100%', height: 'auto', display: 'block' }}
        className={`rounded-xl border border-border object-contain transition-shadow ${
          selected ? 'ring-2 ring-brand ring-offset-1' : ''
        } ${isResizing ? 'select-none' : ''}`}
      />
      {selected && (
        <>
          <div
            role="separator"
            aria-label="왼쪽 리사이즈 핸들"
            onMouseDown={(e) => handleResizeStart(e, 'left')}
            className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-3 cursor-ew-resize rounded-sm border border-border bg-background shadow-md hover:bg-muted"
          />
          <div
            role="separator"
            aria-label="오른쪽 리사이즈 핸들"
            onMouseDown={(e) => handleResizeStart(e, 'right')}
            className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 h-8 w-3 cursor-ew-resize rounded-sm border border-border bg-background shadow-md hover:bg-muted"
          />
        </>
      )}
    </NodeViewWrapper>
  );
}

// ─── Node Definition ──────────────────────────────────────────────────────────
// Extend the built-in Image node to add width attribute + resize NodeView

export const CustomImageNode = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const style = (el as HTMLElement).style.width;
          if (style) return parseInt(style, 10) || null;
          return (el as HTMLElement).getAttribute('width') ? Number((el as HTMLElement).getAttribute('width')) : null;
        },
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes['width']) return {};
          return { style: `width:${attributes['width']}px;max-width:100%;height:auto` };
        },
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
