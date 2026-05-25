'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Italic, Strikethrough, Code, Link2, Highlighter } from 'lucide-react';
import type { Editor } from '@tiptap/core';

export function isMobileDevice(): boolean {
  return typeof window !== 'undefined'
    && 'ontouchstart' in window
    && matchMedia('(max-width: 768px)').matches;
}

interface MenuPos { top: number; left: number }

const MENU_EST_WIDTH = 296; // 6 × 44px + 2×4px padding

export function MobileSelectionMenu({ editor }: { editor: Editor | null }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<MenuPos>({ top: 0, left: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const computePos = useCallback((): MenuPos | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    const selMidX = rect.left + rect.width / 2;
    const left = Math.max(8, Math.min(selMidX - MENU_EST_WIDTH / 2, window.innerWidth - MENU_EST_WIDTH - 8));
    const top = rect.bottom + 8;

    return { top, left };
  }, []);

  useEffect(() => {
    if (!editor) return;

    const onSelectionUpdate = () => {
      if (timerRef.current) clearTimeout(timerRef.current);

      const { from, to } = editor.state.selection;
      if (from === to) { setVisible(false); return; }

      timerRef.current = setTimeout(() => {
        if (!isMobileDevice()) return;
        const p = computePos();
        if (!p) { setVisible(false); return; }
        setPos(p);
        setVisible(true);
      }, 200);
    };

    const onBlur = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setVisible(false);
    };

    editor.on('selectionUpdate', onSelectionUpdate);
    editor.on('blur', onBlur);

    return () => {
      editor.off('selectionUpdate', onSelectionUpdate);
      editor.off('blur', onBlur);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, computePos]);

  if (!visible || !editor) return null;

  const buttons = [
    { icon: Bold, label: '굵게', action: () => editor.chain().focus().toggleBold().run(), active: editor.isActive('bold') },
    { icon: Italic, label: '기울임', action: () => editor.chain().focus().toggleItalic().run(), active: editor.isActive('italic') },
    { icon: Strikethrough, label: '취소선', action: () => editor.chain().focus().toggleStrike().run(), active: editor.isActive('strike') },
    { icon: Code, label: '인라인 코드', action: () => editor.chain().focus().toggleCode().run(), active: editor.isActive('code') },
    {
      icon: Link2,
      label: '링크',
      action: () => {
        if (editor.isActive('link')) { editor.chain().focus().unsetLink().run(); return; }
        const url = window.prompt('URL:');
        if (url) editor.chain().focus().setLink({ href: url }).run();
      },
      active: editor.isActive('link'),
    },
    { icon: Highlighter, label: '형광펜', action: () => editor.chain().focus().toggleHighlight().run(), active: editor.isActive('highlight') },
  ] as const;

  return createPortal(
    <div
      role="toolbar"
      aria-label="텍스트 서식"
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
      className="flex items-center gap-0.5 rounded-xl border border-border bg-background p-1 shadow-lg"
    >
      {buttons.map(({ icon: Icon, label, action, active }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          aria-pressed={active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={action}
          className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
            active
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>,
    document.body,
  );
}
