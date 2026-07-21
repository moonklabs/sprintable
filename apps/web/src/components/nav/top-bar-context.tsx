'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface TopBarState {
  title: ReactNode | null;
  actions: ReactNode | null;
  // 긴급 fix(2076 회귀) — 2뎁스+ 상세 화면(채팅 상세·목표 상세·게이트 상세·루프 상세 등)은
  // title 슬롯 자체에 이미 뒤로가기가 있어, 그 위에 컨텍스트 칩까지 얹으면 <1024에서 공간이
  // 부족해 뭉개진다(선생님 실기기 리포트). "전환은 최상위에서" — 상세 화면은 이미 맥락이
  // 있으므로 칩이 불필요하다는 판단(오르테가군). 페이지가 명시적으로 선언한다(라우트 깊이
  // 추론은 board/goals/standup 등 depth-2지만 root-tab인 화면과 구분이 안 돼 신뢰 불가).
  hideContextChip: boolean;
}

interface TopBarStore extends TopBarState {
  setSlot: (slot: Pick<TopBarState, 'title' | 'actions'> & Partial<Pick<TopBarState, 'hideContextChip'>>) => void;
  clearSlot: () => void;
  hidden: boolean;
  setHidden: (h: boolean) => void;
  scrollContainer: HTMLElement | null;
  setScrollContainer: (el: HTMLElement | null) => void;
}

const TopBarCtx = createContext<TopBarStore | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TopBarState>({ title: null, actions: null, hideContextChip: false });
  const [hidden, setHidden] = useState(false);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const value: TopBarStore = {
    ...state,
    setSlot: (slot) => setState({ hideContextChip: false, ...slot }),
    clearSlot: () => setState({ title: null, actions: null, hideContextChip: false }),
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
