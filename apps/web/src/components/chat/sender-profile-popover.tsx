'use client';

import { useEffect, useRef } from 'react';
import { Bot, ShieldOff, User } from 'lucide-react';

interface SenderProfilePopoverProps {
  x: number;
  y: number;
  name: string;
  isAgent: boolean;
  onClose: () => void;
  /** 생략하면(undefined) 「사용자 차단」 버튼 자체를 안 그린다(자기 자신 클릭 시 호출부가 안 넘김). */
  onBlock?: () => void;
}

// story #2349 — "상대 프로필" 진입점. 이 제품에 다른 멤버를 보는 화면이 없었다(net-new 표면,
// 그라운딩 확認됨) — message-context-menu.tsx와 같은 위치-고정 팝업 패턴을 그대로 재사용해
// 새 상호작용 패턴을 발명하지 않는다.
export function SenderProfilePopover({ x, y, name, isAgent, onClose, onBlock }: SenderProfilePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const menuW = 200;
  const menuH = onBlock ? 96 : 60;
  const clampedX = Math.min(x, window.innerWidth - menuW - 8);
  const clampedY = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={name}
      className="fixed z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover py-2 shadow-md"
      style={{ left: clampedX, top: clampedY }}
    >
      <div className="flex items-center gap-2.5 px-3 py-1.5">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {isAgent ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
        </div>
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
      </div>
      {onBlock && (
        <>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={() => { onBlock(); onClose(); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted"
          >
            <ShieldOff className="h-3.5 w-3.5 text-muted-foreground" />
            사용자 차단
          </button>
        </>
      )}
    </div>
  );
}
