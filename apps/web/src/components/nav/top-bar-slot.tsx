'use client';

import { useEffect, type ReactNode } from 'react';
import { useTopBar } from './top-bar-context';

interface TopBarSlotProps {
  title: ReactNode;
  actions?: ReactNode;
  /** 근본 재구현(2076 회귀 후속) — 기본 false(칩 숨김). 이 화면이 조직/프로젝트 컨텍스트를
   * "훑는" 루트 화면(보드·목표목록·독립 리스트 등)이면 true로 명시해 칩을 켠다. 상세/단일
   * 항목 화면은 아무것도 안 해도(기본값) 칩이 안 뜬다 — hideContextChip 방식(숨길 것 명시)의
   * fail-open 구조적 약점(새 상세 화면마다 빠뜨리기 쉬움, 유나양 규격)을 뒤집은 것. */
  showContextChip?: boolean;
}

export function TopBarSlot({ title, actions = null, showContextChip = false }: TopBarSlotProps) {
  const { setSlot, clearSlot } = useTopBar();
  useEffect(() => {
    setSlot({ title, actions, showContextChip });
    return clearSlot;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, actions, showContextChip]);
  return null;
}
