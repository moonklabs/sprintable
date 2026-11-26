'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { cn } from '@/lib/utils';

/**
 * story 5034 (C4) — the one frame every chat card sits in, so every card has the SAME six states (the story's close rule): ready · loading · empty · error (with «try again») ·
 * hidden («찾을 수 없어요» — a thing that does not exist and a thing the viewer may not see look exactly alike, by design: the server answers both with the same 404) · and the two
 * that are not states but conditions of the content — a long text (the title wraps, it never pushes the card wider) and a narrow screen (the card is always the width of its column).
 * Built only from the design system's parts (Card · Banner · Button · Skeleton): no colour, size or radius of its own.
 */
export type CardFrameState = 'ready' | 'loading' | 'empty' | 'error' | 'hidden';

export interface CardFrameProps {
  state: CardFrameState;
  /** the content of the `ready` state (the caller draws it; the frame never reads a card's data) */
  children?: ReactNode;
  /** «try again» in the `error` state — absent = no button (a part that cannot retry says nothing it cannot do) */
  onRetry?: () => void;
  className?: string;
  'data-testid'?: string;
}

/** «nothing to show» / «not found»: a supporting line (secondary step), never a title — these two are the most common card states in a room and must not be the loudest thing on it (PO, dev lap 11-26) */
function QuietLine({ children }: { children: ReactNode }) {
  return <p className="m-0 px-3 py-3 text-ds-small text-ds-ink-2">{children}</p>;
}

export function CardFrame({ state, children, onRetry, className, 'data-testid': testId }: CardFrameProps) {
  const t = useTranslations('chats');
  const tc = useTranslations('common');
  return (
    <Card className={cn('w-full min-w-0 max-w-full overflow-hidden', className)} data-card-state={state} data-testid={testId}>
      {state === 'loading' ? (
        <SkeletonGroup label={t('cardLoading')} className="flex flex-col gap-2 p-3">
          <Skeleton variant="text" size="card-title" className="w-2/3" />
          <Skeleton variant="text" size="small" className="w-1/3" />
        </SkeletonGroup>
      ) : state === 'empty' ? (
        <QuietLine>{t('cardEmpty')}</QuietLine>
      ) : state === 'hidden' ? (
        <QuietLine>{t('cardHidden')}</QuietLine>
      ) : state === 'error' ? (
        <div className="p-3">
          <Banner tone="failed" action={onRetry ? <Button size="md" variant="secondary" onClick={onRetry}>{tc('retry')}</Button> : undefined}>{t('cardError')}</Banner>
        </div>
      ) : children}
    </Card>
  );
}
