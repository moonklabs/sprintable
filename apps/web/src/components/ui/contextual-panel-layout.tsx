'use client';

import { useCallback, useEffect, useState, type ReactNode, type SetStateAction } from 'react';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent } from '@/components/ui/sheet';

const INLINE_PANEL_MEDIA_QUERY = '(min-width: 1536px)';

function readStoredInlinePanelState(storageKey?: string, defaultOpen = true) {
  if (typeof window === 'undefined' || !storageKey) return defaultOpen;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    // ignore storage errors
  }

  return defaultOpen;
}

function readInlinePanelSupport() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(INLINE_PANEL_MEDIA_QUERY).matches;
}

interface UseContextualPanelStateOptions {
  storageKey?: string;
  defaultOpen?: boolean;
}

interface ScopedBooleanState {
  storageKey?: string;
  value: boolean;
}

function resolveNextBooleanState(next: SetStateAction<boolean>, current: boolean) {
  return typeof next === 'function' ? next(current) : next;
}

export function shouldPersistInlinePanelState(storageKey?: string) {
  return Boolean(storageKey);
}

export function useContextualPanelState({ storageKey, defaultOpen = true }: UseContextualPanelStateOptions = {}) {
  const [supportsInlinePanel, setSupportsInlinePanel] = useState(readInlinePanelSupport);
  const [inlinePanelState, setInlinePanelState] = useState<ScopedBooleanState>(() => ({
    storageKey,
    value: readStoredInlinePanelState(storageKey, defaultOpen),
  }));
  const [drawerState, setDrawerState] = useState<ScopedBooleanState>({ storageKey, value: false });

  const inlinePanelOpen = inlinePanelState.storageKey === storageKey
    ? inlinePanelState.value
    : readStoredInlinePanelState(storageKey, defaultOpen);
  const drawerOpen = drawerState.storageKey === storageKey ? drawerState.value : false;

  const setInlinePanelOpen = useCallback((next: SetStateAction<boolean>) => {
    setInlinePanelState((current) => {
      const currentValue = current.storageKey === storageKey
        ? current.value
        : readStoredInlinePanelState(storageKey, defaultOpen);
      return {
        storageKey,
        value: resolveNextBooleanState(next, currentValue),
      };
    });
  }, [defaultOpen, storageKey]);

  const setDrawerOpen = useCallback((next: SetStateAction<boolean>) => {
    setDrawerState((current) => ({
      storageKey,
      value: resolveNextBooleanState(next, current.storageKey === storageKey ? current.value : false),
    }));
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || !shouldPersistInlinePanelState(storageKey)) return;

    try {
      window.localStorage.setItem(storageKey, inlinePanelOpen ? 'open' : 'closed');
    } catch {
      // ignore storage errors
    }
  }, [inlinePanelOpen, storageKey]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(INLINE_PANEL_MEDIA_QUERY);
    const syncViewport = (event?: MediaQueryListEvent) => {
      const nextMatches = event?.matches ?? mediaQuery.matches;
      setSupportsInlinePanel(nextMatches);
      if (nextMatches) setDrawerOpen(false);
    };

    mediaQuery.addEventListener('change', syncViewport);
    return () => mediaQuery.removeEventListener('change', syncViewport);
  }, [setDrawerOpen]);

  const openPanel = useCallback(() => {
    if (supportsInlinePanel) {
      setInlinePanelOpen(true);
      return;
    }
    setDrawerOpen(true);
  }, [setDrawerOpen, setInlinePanelOpen, supportsInlinePanel]);

  const closePanel = useCallback(() => {
    if (supportsInlinePanel) {
      setInlinePanelOpen(false);
      return;
    }
    setDrawerOpen(false);
  }, [setDrawerOpen, setInlinePanelOpen, supportsInlinePanel]);

  const togglePanel = useCallback(() => {
    if (supportsInlinePanel) {
      setInlinePanelOpen((current) => !current);
      return;
    }
    setDrawerOpen((current) => !current);
  }, [setDrawerOpen, setInlinePanelOpen, supportsInlinePanel]);

  return {
    supportsInlinePanel,
    inlinePanelOpen: supportsInlinePanel && inlinePanelOpen,
    drawerOpen,
    setInlinePanelOpen,
    setDrawerOpen,
    openPanel,
    closePanel,
    closeDrawer: () => setDrawerOpen(false),
    togglePanel,
  };
}

interface ContextualPanelLayoutProps {
  renderPanel: (args: { mode: 'inline' | 'drawer'; closePanel: () => void }) => ReactNode;
  children: ReactNode;
  inlinePanelOpen: boolean;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  drawerAriaLabel: string;
  className?: string;
  panelClassName?: string;
  contentClassName?: string;
  inlineColumnsClassName?: string;
  drawerWidthClassName?: string;
  drawerSide?: 'left' | 'right';
}

export function ContextualPanelLayout({
  renderPanel,
  children,
  inlinePanelOpen,
  drawerOpen,
  onDrawerOpenChange,
  drawerAriaLabel,
  className,
  panelClassName,
  contentClassName,
  inlineColumnsClassName = '2xl:grid-cols-[320px_minmax(0,1fr)]',
  drawerWidthClassName = 'w-[min(92vw,24rem)]',
  drawerSide = 'left',
}: ContextualPanelLayoutProps) {
  return (
    <>
      <div className={cn('grid gap-4', inlinePanelOpen ? inlineColumnsClassName : 'grid-cols-1', className)}>
        {inlinePanelOpen ? (
          <div className={cn('min-w-0', panelClassName)}>
            {renderPanel({ mode: 'inline', closePanel: () => onDrawerOpenChange(false) })}
          </div>
        ) : null}
        <div className={cn('min-w-0', contentClassName)}>{children}</div>
      </div>

      {/* 서랍 가지 — story 4831: 손으로 지은 role=dialog + 가림막 단추 + useFocusTrap 대신 바탕 Sheet. 모달 · 가림막 · 초점(진입 · 가두기 · 반환) · Esc 한 층은 Sheet(Base UI)가 맡는다.
          (옛 주석은 «renderPanel이 inline/drawer 겸용이라 Dialog로 못 감싼다»였지만, 서랍 가지에서만 renderPanel({ mode: 'drawer' })를 따로 부르므로 이 가지만 감싸면 된다.)
          패널(GlassPanel 등)이 자기 카드 면을 가져서 Sheet는 «투명 껍데기»로만 쓴다(면 · 테두리는 같은 변형으로 덮어쓰고, 그림자는 !shadow-none — tailwind-merge가 shadow-[var(--elev-overlay)]와 shadow-none을 합치지 않아 두 클래스가 다 남으므로 CSS 순서에 기대지 않게 중요 표시로 못 박는다) — 카드 위에 카드가 겹치지 않는다.
          폭과 안쪽 여백 12px는 같은 안쪽 칸이 가진다(옛 서랍과 같게: 폭에 여백이 «포함»돼 카드 = 폭 − 24px — 여백을 껍데기에 주면 카드가 24px 넓어진다. 실제 Chromium으로 재서 잡았다).
          넓은 화면(2xl 이상)으로 넘어가면 서랍을 닫는 것은 useContextualPanelState가 한다 — 모달은 CSS로 숨겨도 열려 남으므로 2xl:hidden을 두지 않는다. */}
      <Sheet open={drawerOpen} onOpenChange={(open) => onDrawerOpenChange(open)}>
        <SheetContent
          side={drawerSide}
          showCloseButton={false}
          aria-label={drawerAriaLabel}
          className="gap-0 bg-transparent !shadow-none data-[side=left]:w-auto data-[side=right]:w-auto data-[side=left]:border-r-0 data-[side=right]:border-l-0 data-[side=left]:sm:max-w-none data-[side=right]:sm:max-w-none"
        >
          <div className={cn('flex h-full min-h-0 flex-col p-3', drawerWidthClassName)}>
            {renderPanel({ mode: 'drawer', closePanel: () => onDrawerOpenChange(false) })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
