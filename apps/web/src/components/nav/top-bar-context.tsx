'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface TopBarState {
  title: ReactNode | null;
  actions: ReactNode | null;
}

interface TopBarStore extends TopBarState {
  setSlot: (slot: TopBarState) => void;
  clearSlot: () => void;
  hidden: boolean;
  setHidden: (h: boolean) => void;
  scrollContainer: HTMLElement | null;
  setScrollContainer: (el: HTMLElement | null) => void;
}

const TopBarCtx = createContext<TopBarStore | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TopBarState>({ title: null, actions: null });
  const [hidden, setHidden] = useState(false);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const value: TopBarStore = {
    ...state,
    setSlot: (slot) => setState(slot),
    clearSlot: () => setState({ title: null, actions: null }),
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
