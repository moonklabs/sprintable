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

type TopBarFallback = { title: ReactNode; showContextChip: boolean } | null;

interface TopBarStore extends TopBarState {
  setSlot: (slot: Pick<TopBarState, 'title' | 'actions'> & Partial<Pick<TopBarState, 'showContextChip'>>) => void;
  clearSlot: () => void;
  /**
   * story #4291(AC3) — 화면이 슬롯을 비운 사이(옛 화면 언마운트 → 새 화면 마운트 전 · 로딩 경계가 뜬 동안) 보일 제목. 레이아웃이 쥔다
   * (예: 일감 탭 띠가 도착 탭의 제목). 화면 슬롯이 있으면 늘 그쪽이 이긴다 — 레이아웃 effect가 화면 effect보다 늦게 돌아도 덮어쓰지 않게
   * 슬롯과 따로 둔다. actions는 폴백에 없다(화면만 안다).
   */
  setFallback: (fallback: TopBarFallback) => void;
  hidden: boolean;
  setHidden: (h: boolean) => void;
  scrollContainer: HTMLElement | null;
  setScrollContainer: (el: HTMLElement | null) => void;
}

const TopBarCtx = createContext<TopBarStore | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TopBarState>({ title: null, actions: null, showContextChip: false });
  const [fallback, setFallback] = useState<TopBarFallback>(null);
  const slotEmpty = state.title === null;
  const [hidden, setHidden] = useState(false);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const value: TopBarStore = {
    ...state,
    title: slotEmpty ? (fallback?.title ?? null) : state.title,
    showContextChip: slotEmpty ? (fallback?.showContextChip ?? false) : state.showContextChip,
    setFallback,
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
