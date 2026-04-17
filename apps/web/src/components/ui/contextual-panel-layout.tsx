'use client';

import { useCallback, useEffect, useState, type ReactNode, type SetStateAction } from 'react';
import { cn } from '@/lib/utils';

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

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 2xl:hidden" role="dialog" aria-modal="true" aria-label={drawerAriaLabel}>
          <button
            type="button"
            aria-label={drawerAriaLabel}
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            onClick={() => onDrawerOpenChange(false)}
          />
          <div
            className={cn(
              'absolute inset-y-0 p-3',
              drawerWidthClassName,
              drawerSide === 'left' ? 'left-0' : 'right-0',
            )}
          >
            <div className="flex h-full min-h-0 flex-col">
              {renderPanel({ mode: 'drawer', closePanel: () => onDrawerOpenChange(false) })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
