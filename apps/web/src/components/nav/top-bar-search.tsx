'use client';

import { useSyncExternalStore } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { Kbd } from '@/components/ds/kbd';
import { shortcutHint } from '@/lib/keyboard-shortcuts';

// story 5031 (C1 step 5a · PO 11-27): the desktop top bar's middle — a field that looks like a search box and is a BUTTON: it opens the same ⌘K palette the icon bar's search and the phone's icon open (one door, one place to type).
// Kit sizes: height 40 (the control height) · radius 8 · 1px line · left 12 / right 16 · icon 24 · 12 between icon and text · text 16 Regular, third-grade ink. Only ds tokens (the face of ds Input: surface + line-control; a pressable one-door button keeps the pressable focus ring).
// The element is the base-ui button primitive the ds IconButton is made of (a field-shaped press — no ds part has this face, and a plain button element is held to the Button part by verify:no-new-raw-button).
// The hint is drawn only for a key that really exists (REAL_SHORTCUTS): ⌘K on a Mac, Ctrl K elsewhere. Read after hydration (the server does not know the computer).
const noopSubscribe = () => () => {};
const isMac = (): boolean => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? '');
};

export function TopBarSearch({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const t = useTranslations('nav');
  const mac = useSyncExternalStore(noopSubscribe, isMac, () => false);
  const hint = shortcutHint(['⌘', 'K'], mac);
  return (
    <ButtonPrimitive
      type="button"
      data-testid="top-bar-search-field"
      onClick={onOpen}
      className={cn(
        'flex h-ds-control w-full min-w-0 items-center gap-ds-3 rounded-ds-control border border-ds-line-control bg-ds-surface pl-ds-3 pr-ds-4 text-left text-base font-normal text-ds-ink-3 outline-none',
        'transition-colors duration-(--ds-duration-fast) motion-reduce:transition-none hover:bg-ds-surface-high',
        'focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background',
        className,
      )}
    >
      <Icon name="search" size="md" />
      <span className="min-w-0 flex-1 truncate">{t('topBarSearch')}</span>
      {hint ? <Kbd className="shrink-0">{hint}</Kbd> : null}
    </ButtonPrimitive>
  );
}
