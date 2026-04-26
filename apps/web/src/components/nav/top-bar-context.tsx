'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface TopBarState {
  title: ReactNode | null;
  actions: ReactNode | null;
}

interface TopBarStore extends TopBarState {
  setSlot: (slot: TopBarState) => void;
  clearSlot: () => void;
}

const TopBarCtx = createContext<TopBarStore | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TopBarState>({ title: null, actions: null });
  const value: TopBarStore = {
    ...state,
    setSlot: (slot) => setState(slot),
    clearSlot: () => setState({ title: null, actions: null }),
  };
  return <TopBarCtx.Provider value={value}>{children}</TopBarCtx.Provider>;
}

export function useTopBar() {
  const ctx = useContext(TopBarCtx);
  if (!ctx) throw new Error('useTopBar must be used inside TopBarProvider');
  return ctx;
}
