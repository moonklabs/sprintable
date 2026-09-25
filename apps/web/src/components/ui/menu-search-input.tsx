'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';

// story #4306(유나 4646 재측) — 드롭다운 메뉴(Base UI Menu) 안의 검색칸. 예전 `<Input autoFocus>`는 메뉴가 그려지는 순간 먼저 초점을 가져가고,
// 그 뒤 메뉴의 목록 탐색이 «메뉴 안에 초점이 있다»고 보고 첫 항목으로 초점을 옮겼다 — 입력이 메뉴 타이프어헤드로 새고 검색칸이 비었다.
// `autoFocus`를 두지 않으면 메뉴의 초점 관리(FloatingFocusManager initialFocus)가 팝업의 첫 초점 가능 요소 = 이 검색칸에 초점을 준다
// (메뉴 항목은 tabIndex -1) — 키보드로 열어도 포인터로 열어도. 그래서 이 칸은 `autoFocus`를 받지 않는다(타입에서도 뺀다).
// 드롭다운 안 검색칸은 이것 하나로 쓴다(가드: menu-search-input.guard.test.ts · 렌더: kanban-board.test.tsx «필터 메뉴를 열면 초점 = 검색칸»).
//
// 키(유나 확정 · 4306 본문 끝 절):
// - 검색칸은 글자만 삼킨다(글자 · 스페이스 · Backspace · ←/→ · Home/End) — 메뉴 타이프어헤드로 새지 않게.
// - ↓ = 목록 첫 항목으로 초점(보이는 순서 그대로 · 보통 «전체 …»가 첫째).
// - Esc = 메뉴로 통과(닫힘 + 트리거로 초점) · Tab = 메뉴로 통과(닫힘 · 다음으로).
// - Enter(검색칸) = 아무것도 안 함.
// - 항목 위에선 메뉴 기본(↑↓ · Enter · Esc). 단 첫 항목에서 ↑ = 검색칸으로 돌아온다(맨 끝으로 감지 않는다 — 다시 거를 자리).
const PASS_THROUGH_KEYS = new Set(['Escape', 'Tab']);

/** 번역된 자리표시 글자(«스프린트 검색...»)에서 끝의 말줄임을 뺀 접근 이름 — 호출부가 aria-label을 따로 주면 그것. */
function accessibleName(placeholder: string | undefined): string | undefined {
  return placeholder?.replace(/(\.{3}|…)\s*$/, '').trim() || undefined;
}

function firstMenuItem(input: HTMLElement | null): HTMLElement | null {
  return input?.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? null;
}

export function MenuSearchInput({ onKeyDown, placeholder, ...props }: Omit<React.ComponentProps<typeof Input>, 'autoFocus' | 'ref'>) {
  const ref = React.useRef<HTMLInputElement>(null);

  // 첫 항목에서 ↑ → 검색칸으로. 메뉴 목록 탐색(맨 끝으로 감기)보다 먼저 받도록 메뉴에 캡처 단계로 건다.
  React.useEffect(() => {
    const menu = ref.current?.closest('[role="menu"]');
    if (!menu) return undefined;
    const onMenuKeyDown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'ArrowUp' || ke.target !== firstMenuItem(ref.current)) return;
      ke.preventDefault();
      ke.stopPropagation();
      ref.current?.focus();
    };
    menu.addEventListener('keydown', onMenuKeyDown, true);
    return () => menu.removeEventListener('keydown', onMenuKeyDown, true);
  }, []);

  return (
    <Input
      aria-label={accessibleName(placeholder)}
      {...props}
      ref={ref}
      placeholder={placeholder}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (PASS_THROUGH_KEYS.has(e.key)) return;
        e.stopPropagation();
        // Enter는 여기서 멈춘다(메뉴로 안 올라가 항목을 고르지 않음 = 아무것도 안 함).
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          firstMenuItem(ref.current)?.focus();
        }
      }}
    />
  );
}
