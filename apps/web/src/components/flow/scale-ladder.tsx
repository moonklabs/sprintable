'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * story #2531(E-FLOW-V4 S1)에서 지구층 전용으로 태어났다가, story #2535(S5)에서 다른 층
 * (갈래·목록)에도 재사용하도록 분리됐다 — «지금 보는 층 = 묻는 질문 전환»(doc
 * flow-board-v4-hypothesis-scale §2)을 어느 뷰에서도 같은 자리에서 보여준다.
 *
 * 유나 design 재규격(2026-08-09, prod 前 정정) — 지구/대륙/도시/거리/건물 같은 «행성 은유»
 * legend 줄을 뺐다(사용자에게 의미 없는 이름표라는 지적). 각 rung은 이제 이름(가설/목표/
 * 갈래/스토리/작업)+질문(무엇을 검증하는가…) 둘만 — active 강조는 그 이름 쪽으로 옮겨졌다.
 */
export const LADDER_LEVELS = ['earth', 'continent', 'city', 'street', 'building'] as const;
export type LadderLevel = (typeof LADDER_LEVELS)[number];

export function ScaleLadder({ activeLevel = 'earth', compact = false }: { activeLevel?: LadderLevel; compact?: boolean }) {
  const t = useTranslations('flow');

  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — <lg에서 이 카드열(이름+질문 5칸, py-2.5)이
  // 「주」처럼 보여 보드(칸반) 콘텐츠를 아래로 밀어냈다(유나 실측). 래더는 원래 역할이 보드의
  // 렌즈/필터(지금 보는 층 표시)일 뿐이라 — 칩열로 낮춘다. 질문 문구(ladderQuestion_*)는
  // 이 압축판에서 뺀다(공간 예산 안에서 이름만으로도 "지금 보는 층" 신호는 충분 — active
  // 강조·순서 자체가 이미 그 정보를 나른다). 상호작용(onClick)은 원본에도 없던 것이라
  // 여기서도 추가하지 않는다(read-only 브레드크럼 그대로, 회귀 0).
  if (compact) {
    return (
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border bg-card px-1.5 py-1">
        {LADDER_LEVELS.map((level) => {
          const active = level === activeLevel;
          return (
            <span
              key={level}
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition',
                active ? 'bg-brand/10 text-brand' : 'text-muted-foreground',
              )}
            >
              {t(`ladderName_${level}`)}
            </span>
          );
        })}
      </div>
    );
  }

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
            <div className={cn('text-sm font-semibold text-foreground', active && 'text-brand')}>
              {t(`ladderName_${level}`)}
            </div>
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
