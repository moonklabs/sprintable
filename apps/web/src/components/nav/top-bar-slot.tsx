'use client';

import { useEffect, type ReactNode } from 'react';
import { useTopBar } from './top-bar-context';

interface TopBarSlotProps {
  title: ReactNode;
  actions?: ReactNode;
  /** 긴급 fix(2076 회귀) — 이 화면의 title이 이미 자체 뒤로가기를 갖는 상세 화면이면 true로
   * 컨텍스트 칩을 뺀다(<1024에서 공간 부족으로 뭉개지는 문제). */
  hideContextChip?: boolean;
}

export function TopBarSlot({ title, actions = null, hideContextChip = false }: TopBarSlotProps) {
  const { setSlot, clearSlot } = useTopBar();
  useEffect(() => {
    setSlot({ title, actions, hideContextChip });
    return clearSlot;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, actions, hideContextChip]);
  return null;
}
