'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { LoopStatus } from './loop-status-badge';

/**
 * 4911 — 실행(루프)의 단계 막대. 일곱 상태가 한 줄로 이어지는 순서(초안 → 브리핑 → 생성 중 → 결정 중 → 실행 중 → 측정 중 → 종료).
 * 앞 단계 = 채움 · 지금 단계 = 윤곽 + 속 옅은 색 · 뒤 단계 = 속 빈 칸. 종료는 일곱 칸이 다 찬다. 중단(abandoned)은 이 줄 위에 있지 않아 막대를 그리지 않는다(칩이 «중단»을 말한다).
 * 색만으로 말하지 않는다: 막대는 그림이고(role=img), 읽는 글은 «7단계 중 N번째»가 따로 싣는다 — 단계 이름은 옆 칩이 말한다.
 */
export const LOOP_STAGE_ORDER = ['draft', 'briefing', 'generating', 'deciding', 'executing', 'measuring', 'closed'] as const satisfies readonly LoopStatus[];

export function loopStageIndex(status: LoopStatus): number {
  return (LOOP_STAGE_ORDER as readonly string[]).indexOf(status);
}

export function LoopStageBar({ status, className }: { status: LoopStatus; className?: string }) {
  const t = useTranslations('loops');
  const at = loopStageIndex(status);
  if (at < 0) return null;
  const finished = status === 'closed';
  return (
    <span
      role="img"
      aria-label={t('stageBarLabel', { at: at + 1, total: LOOP_STAGE_ORDER.length })}
      data-slot="loop-stage-bar"
      data-stage={at + 1}
      className={cn('inline-flex shrink-0 items-center gap-0.5', className)}
    >
      {LOOP_STAGE_ORDER.map((id, i) => {
        const state = finished || i < at ? 'done' : i === at ? 'current' : 'upcoming';
        return (
          <span
            key={id}
            aria-hidden="true"
            data-state={state}
            className={cn(
              'h-1.5 w-3 rounded-full border',
              state === 'done' && 'border-ds-done bg-ds-done',
              state === 'current' && 'border-ds-action bg-ds-action-soft',
              state === 'upcoming' && 'border-ds-line-control bg-transparent',
            )}
          />
        );
      })}
    </span>
  );
}
