'use client';

import { useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldOff } from 'lucide-react';
import { Avatar } from '@/components/shared/avatar';
import { Popover, PopoverContent } from '@/components/ui/popover';

interface SenderProfilePopoverProps {
  x: number;
  y: number;
  /** 표시 텍스트(팝업 제목·aria-label) — 호출부가 이미 낱말 폴백("당신"/"팀" 등)을
   * 적용해 넘긴다. */
  name: string;
  /** story #3791(페드루 재검토 12:23Z) — Avatar 이니셜 «재료»(원시). name(표시 문구)을
   * 그대로 Avatar에 넘기면 그 첫 글자가 가짜 이니셜로 뜬다 — 이 필드가 그 경계를
   * 가른다. 생략 시(name 자체가 이미 실명인 소비처) name을 재료로도 그대로 쓴다. */
  rawName?: string;
  isAgent: boolean;
  /** story #2968(카디르 QA #3397 MEDIUM) — chat-bubble.tsx가 이미 들고 있던 sender_avatar_url을
   * 안 넘겨 이 팝업만 Bot/User 하드코딩 아이콘에 머물러 있었다. avatar.tsx 정본 배선. */
  avatarUrl?: string | null;
  /** story #3106(#3092 후속) — chat-bubble.tsx의 message.sender_runtime_type 그대로. agent만
   * 값 있고 human은 null(Avatar.runtimeType과 동형 규율). */
  runtimeType?: string | null;
  onClose: () => void;
  /** 생략하면(undefined) 「사용자 차단」 버튼 자체를 안 그린다(자기 자신 클릭 시 호출부가 안 넘김). */
  onBlock?: () => void;
}

/** 클릭한 점(x, y)을 «크기 0 사각형» 기준으로 — Base UI Positioner의 가상 기준(anchor)으로 넘긴다. */
export function pointAnchor(x: number, y: number) {
  return {
    getBoundingClientRect: () => ({ x, y, width: 0, height: 0, top: y, left: x, right: x, bottom: y }),
  };
}

// story #2349 — "상대 프로필" 진입점. 이 제품에 다른 멤버를 보는 화면이 없었다(net-new 표면,
// 그라운딩 확認됨) — 클릭한 점에 띄우는 위치-고정 팝업이다.
// story 4831 — 손으로 지은 fixed + document 리스너 팝업을 바탕 Popover 부품 위로. 바깥 누름 · Esc 닫기는 base-ui가 맡고,
// 자리는 클릭한 점(가상 기준)의 아래-왼쪽 모서리에 붙인다(창 끝에서는 base-ui가 밀어 넣는다).
export function SenderProfilePopover({ x, y, name, rawName, isAgent, avatarUrl, runtimeType, onClose, onBlock }: SenderProfilePopoverProps) {
  // story #3776(1층A) — "사용자 차단" 버튼, chats ns의 기존 blockUserConfirmConfirm 키 재사용.
  const tChats = useTranslations('chats');
  const anchor = useMemo(() => pointAnchor(x, y), [x, y]);

  // 손으로 지은 팝업은 «바깥에서 어느 버튼이든 누르는 순간(pointerdown)» 닫았다. Base UI는 마우스 주 버튼의 «click»(뗀 뒤)만 바깥 누름으로 보므로 드래그 시작 · 오른쪽 · 가운데 ·
  // Ctrl-클릭이 닫지 못한다(우클릭 메뉴가 뜬 뒤에도 이 프로필이 열려 두 층이 겹침 — 같은 말풍선이든 다른 말풍선이든). 옛 길을 그대로 복원한다(팝업 안은 제외).
  // contextmenu는 키보드로 여는 메뉴(pointerdown 없이 옴)까지 덮는 보강이다. 터치는 Base UI도 누르는 순간 닫는다.
  useEffect(() => {
    const closeIfOutside = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('[data-sender-profile-popup]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeIfOutside, true);
    document.addEventListener('contextmenu', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
      document.removeEventListener('contextmenu', closeIfOutside, true);
    };
  }, [onClose]);

  return (
    <Popover open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverContent
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={0}
        aria-label={name}
        data-sender-profile-popup=""
        className="w-auto min-w-[200px] overflow-hidden p-0 py-2"
      >
        <div className="flex items-center gap-2.5 px-3 py-1.5">
          <Avatar
            name={rawName ?? name}
            label={rawName !== undefined ? name : undefined}
            avatarUrl={avatarUrl ?? null}
            actorType={isAgent ? 'agent' : 'human'}
            size={32}
            runtimeType={runtimeType ?? null}
          />
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
              {tChats('blockUserConfirmConfirm')}
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
