'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * story #2531(E-FLOW-V4 S1)에서 지구층 전용으로 태어났다가, story #2535(S5)에서 다른 층
 * (갈래·목록)에도 재사용하도록 분리됐다 — «지금 보는 층 = 묻는 질문 전환»(doc
 * flow-board-v4-hypothesis-scale §2)을 어느 뷰에서도 같은 자리에서 보여준다.
 */
export const LADDER_LEVELS = ['earth', 'continent', 'city', 'street', 'building'] as const;
export type LadderLevel = (typeof LADDER_LEVELS)[number];

export function ScaleLadder({ activeLevel = 'earth' }: { activeLevel?: LadderLevel }) {
  const t = useTranslations('flow');
  return (
    <div className="flex overflow-hidden rounded-xl border border-border bg-card">
      {LADDER_LEVELS.map((level) => {
        const active = level === activeLevel;
        return (
          <div
            key={level}
            className={cn(
              'relative flex-1 border-r border-border px-3 py-2.5 last:border-r-0',
              active && 'bg-gradient-to-b from-brand/10 to-transparent',
            )}
          >
            <div className={cn('text-[10px] font-semibold tracking-wide text-muted-foreground', active && 'text-brand')}>
              {t(`ladderLevel_${level}`)}
            </div>
            <div className="mt-0.5 text-sm font-semibold text-foreground">{t(`ladderName_${level}`)}</div>
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{t(`ladderQuestion_${level}`)}</div>
            <span
              aria-hidden="true"
              className={cn('absolute top-2.5 right-2.5 size-2 rounded-full bg-border', active && 'bg-brand')}
            />
          </div>
        );
      })}
    </div>
  );
}
