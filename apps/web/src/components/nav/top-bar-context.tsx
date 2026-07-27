'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface TopBarState {
  title: ReactNode | null;
  actions: ReactNode | null;
  // 근본 재구현(2076 회귀 후속, 유나양 규격) — 애초 "숨길 화면을 명시(hideContextChip)"가
  // fail-open 구조였다(docs·mockups·retro가 뒤로가기 신호 부재로 grep에서 3차례 누락되며
  // 실측으로 증명됨). "표시할 루트만 명시·기본 숨김"으로 뒤집는다 — 새 상세 화면이 생겨도
  // 기본이 "칩 없음"이라 구조적으로 안 샌다. 화면이 명시적으로 켜야 보인다.
  showContextChip: boolean;
}

interface TopBarStore extends TopBarState {
  setSlot: (slot: Pick<TopBarState, 'title' | 'actions'> & Partial<Pick<TopBarState, 'showContextChip'>>) => void;
  clearSlot: () => void;
  hidden: boolean;
  setHidden: (h: boolean) => void;
  scrollContainer: HTMLElement | null;
  setScrollContainer: (el: HTMLElement | null) => void;
}

const TopBarCtx = createContext<TopBarStore | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TopBarState>({ title: null, actions: null, showContextChip: false });
  const [hidden, setHidden] = useState(false);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const value: TopBarStore = {
    ...state,
    setSlot: (slot) => setState({ showContextChip: false, ...slot }),
    clearSlot: () => setState({ title: null, actions: null, showContextChip: false }),
    hidden,
    setHidden,
    scrollContainer,
    setScrollContainer,
  };
  return <TopBarCtx.Provider value={value}>{children}</TopBarCtx.Provider>;
}

export function useTopBar() {
  const ctx = useContext(TopBarCtx);
  if (!ctx) throw new Error('useTopBar must be used inside TopBarProvider');
  return ctx;
}
