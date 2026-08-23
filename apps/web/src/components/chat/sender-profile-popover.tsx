'use client';

import { useEffect, useRef } from 'react';
import { ShieldOff } from 'lucide-react';
import { Avatar } from '@/components/shared/avatar';

interface SenderProfilePopoverProps {
  x: number;
  y: number;
  name: string;
  isAgent: boolean;
  /** story #2968(카디르 QA #3397 MEDIUM) — chat-bubble.tsx가 이미 들고 있던 sender_avatar_url을
   * 안 넘겨 이 팝업만 Bot/User 하드코딩 아이콘에 머물러 있었다. avatar.tsx 정본 배선. */
  avatarUrl?: string | null;
  onClose: () => void;
  /** 생략하면(undefined) 「사용자 차단」 버튼 자체를 안 그린다(자기 자신 클릭 시 호출부가 안 넘김). */
  onBlock?: () => void;
}

// story #2349 — "상대 프로필" 진입점. 이 제품에 다른 멤버를 보는 화면이 없었다(net-new 표면,
// 그라운딩 확認됨) — message-context-menu.tsx와 같은 위치-고정 팝업 패턴을 그대로 재사용해
// 새 상호작용 패턴을 발명하지 않는다.
export function SenderProfilePopover({ x, y, name, isAgent, avatarUrl, onClose, onBlock }: SenderProfilePopoverProps) {
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
        <Avatar name={name} avatarUrl={avatarUrl ?? null} actorType={isAgent ? 'agent' : 'human'} size={32} />
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
