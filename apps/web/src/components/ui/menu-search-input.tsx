'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';

// story #4306(유나 4646 재측) — 드롭다운 메뉴(Base UI Menu) 안의 검색칸. 예전 `<Input autoFocus>`는 메뉴가 그려지는 순간 먼저 초점을 가져가고,
// 그 뒤 메뉴의 목록 탐색이 «메뉴 안에 초점이 있다»고 보고 첫 항목으로 초점을 옮겼다 — 입력이 메뉴 타이프어헤드로 새고 검색칸이 비었다.
// `autoFocus`를 두지 않으면 메뉴의 초점 관리(FloatingFocusManager initialFocus)가 팝업의 첫 초점 가능 요소 = 이 검색칸에 초점을 준다
// (메뉴 항목은 tabIndex -1) — 키보드로 열어도 포인터로 열어도. 그래서 이 칸은 `autoFocus`를 받지 않고(타입에서도 뺀다), 키 입력은
// 메뉴(타이프어헤드 · 화살표)로 올라가지 않게 막는다. 드롭다운 안 검색칸은 이것 하나로 쓴다(가드: menu-search-input.guard.test.ts ·
// 렌더: kanban-board.test.tsx «필터 메뉴를 열면 초점 = 검색칸» 키보드 · 포인터 · 바로 입력).
export function MenuSearchInput({ onKeyDown, ...props }: Omit<React.ComponentProps<typeof Input>, 'autoFocus'>) {
  return (
    <Input
      {...props}
      onKeyDown={(e) => {
        e.stopPropagation();
        onKeyDown?.(e);
      }}
    />
  );
}
