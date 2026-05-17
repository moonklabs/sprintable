'use client';

import { useEffect, useRef } from 'react';
import { MessageSquareReply, Copy, Trash2 } from 'lucide-react';

interface MessageContextMenuProps {
  x: number;
  y: number;
  isMine: boolean;
  onReply: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function MessageContextMenu({ x, y, isMine, onReply, onCopy, onDelete, onClose }: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Clamp menu inside viewport
  const menuW = 160;
  const menuH = isMine ? 112 : 80;
  const clampedX = Math.min(x, window.innerWidth - menuW - 8);
  const clampedY = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-md"
      style={{ left: clampedX, top: clampedY }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => { onReply(); onClose(); }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted"
      >
        <MessageSquareReply className="h-3.5 w-3.5 text-muted-foreground" />
        답글 달기
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => { onCopy(); onClose(); }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted"
      >
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        복사
      </button>
      {isMine && (
        <>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => { onDelete(); onClose(); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            삭제
          </button>
        </>
      )}
    </div>
  );
}
