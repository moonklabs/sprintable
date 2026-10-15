'use client';

// story #4413(유나 자리 결정 · PO 00:23Z) — 명령 팔레트 열림 상태를 셸 층 한 벌로 올린다. 데스크톱 사이드바 검색 단추 · ⌘K ·
// 폰 «전체»(/more) 맨 위 검색 행이 같은 상태를 연다. 예전엔 상태와 팔레트가 사이드바 안에만 있어, 폰(사이드바가 시트라 닫혀 있으면
// 안 그려짐)에서는 전역 검색을 여는 길이 0이었다.

import { createContext, useCallback, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

interface CommandPaletteState {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  openPalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteState | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ open, setOpen, openPalette }), [open, openPalette]);
  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

/**
 * 셸의 팔레트 상태. 공급자 밖(사이드바를 따로 그리는 테스트 등)에서는 자기 상태로 대신한다 — 훅 순서가 늘 같게 useState는 항상 부른다.
 */
export function useCommandPalette(): CommandPaletteState {
  const shared = useContext(CommandPaletteContext);
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  const local = useMemo(() => ({ open, setOpen, openPalette }), [open, openPalette]);
  return shared ?? local;
}

/** 공급자 안에서만 여는 쪽(«전체» 검색 행) — 공급자가 없으면 null(행을 그리지 않는다). */
export function useCommandPaletteOpener(): (() => void) | null {
  return useContext(CommandPaletteContext)?.openPalette ?? null;
}
