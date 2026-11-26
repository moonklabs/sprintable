'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { CardFrame, type CardFrameState } from './card-frame';
import { EntityCardFace } from './entity-card';

/**
 * story 5034 (C4) — the state toggle the story closes on: ONE place to flip a chat card through [default · loading · empty · error · not visible · long text] and between a phone width (390) and a
 * desktop width (1440). It draws the same parts a message does (CardFrame · EntityCardFace) with fixed example words — no reads. Shown on /design-system.
 */
type Shown = 'ready' | 'loading' | 'empty' | 'error' | 'hidden' | 'long';
const SHOWN: readonly Shown[] = ['ready', 'loading', 'empty', 'error', 'hidden', 'long'];
export const SHOWCASE_WIDTHS = { narrow: 390, wide: 1440 } as const;

export function CardStatesShowcase() {
  const t = useTranslations('chats');
  const [shown, setShown] = useState<Shown>('ready');
  const [wide, setWide] = useState(false);
  // (literal key calls — the dead-key scan reads those)
  const stateLabel = (s: Shown): string => {
    switch (s) {
      case 'ready': return t('cardStateReady');
      case 'loading': return t('cardStateLoading');
      case 'empty': return t('cardStateEmpty');
      case 'error': return t('cardStateError');
      case 'hidden': return t('cardStateHidden');
      case 'long': return t('cardStateLong');
    }
  };
  const frameState: CardFrameState = shown === 'long' ? 'ready' : shown;
  return (
    <section data-testid="chat-card-states-showcase" className="mt-6 min-w-0">
      <h2 className="m-0 mb-2 text-ds-card-title font-semibold text-ds-ink">{t('cardShowcaseTitle')}</h2>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {SHOWN.map((s) => (
          <Button key={s} size="md" variant={shown === s ? 'primary' : 'secondary'} aria-pressed={shown === s} onClick={() => setShown(s)}>{stateLabel(s)}</Button>
        ))}
        <Button size="md" variant={wide ? 'secondary' : 'primary'} aria-pressed={!wide} onClick={() => setWide(false)}>{t('cardWidthNarrow')}</Button>
        <Button size="md" variant={wide ? 'primary' : 'secondary'} aria-pressed={wide} onClick={() => setWide(true)}>{t('cardWidthWide')}</Button>
      </div>
      <div data-testid="chat-card-states-stage" style={{ width: wide ? SHOWCASE_WIDTHS.wide : SHOWCASE_WIDTHS.narrow, maxWidth: '100%' }}>
        {frameState === 'ready' ? (
          <EntityCardFace kind="story" statusLabel={t('cardSampleStatus')} title={shown === 'long' ? t('cardSampleLong') : t('cardSampleTitle')} />
        ) : (
          <CardFrame state={frameState} onRetry={() => setShown('ready')} />
        )}
      </div>
    </section>
  );
}
