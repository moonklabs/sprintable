'use client';

import { useEffect, useRef } from 'react';
import { MessageSquareReply, Copy, Trash2, Quote } from 'lucide-react';

export interface CiteAction {
  /** story #2265(C-7) PR2 — 아직 선택 중이 아니면 "start"(여기부터), 이미 다른 메시지가
   * anchor로 찍힌 중이면 "end"(여기까지). 라벨/판단은 호출부(use-message-range-selection
   * 소비부)가 정하고, 이 메뉴는 그 결정을 그대로 그린다. */
  kind: 'start' | 'end';
  onSelect: () => void;
}

interface MessageContextMenuProps {
  x: number;
  y: number;
  isMine: boolean;
  onReply: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** 생략하면(undefined) 인용 항목 자체를 안 그린다 — 기존 호출부 무변경 보장. */
  citeAction?: CiteAction;
  /** story #2319 — 이미 tombstone된 메시지는 「삭제」를 다시 제시하지 않는다(no-op 액션 노출 금지). */
  isDeleted?: boolean;
}

export function MessageContextMenu({ x, y, isMine, onReply, onCopy, onDelete, onClose, citeAction, isDeleted = false }: MessageContextMenuProps) {
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
  const menuH = (isMine ? 112 : 80) + (citeAction ? 36 : 0);
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
      {citeAction && (
        <button
          type="button"
          role="menuitem"
          onClick={() => { citeAction.onSelect(); onClose(); }}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted"
        >
          <Quote className="h-3.5 w-3.5 text-muted-foreground" />
          {citeAction.kind === 'start' ? '여기부터 인용' : '여기까지 인용'}
        </button>
      )}
      {isMine && !isDeleted && (
        <>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => { onDelete(); onClose(); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            삭제
          </button>
        </>
      )}
    </div>
  );
}
