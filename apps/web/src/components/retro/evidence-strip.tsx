'use client';

import { useTranslations } from 'next-intl';
import type { RetroHypothesisResult } from '@/services/retro-session';

/**
 * E-SPRINT-LOOP FE(1b9f4ecb) — 진행 단계(수집/우선순위/액션)용 얇은 evidence strip(핸드오프 §4·목업 PART 5).
 * 종료 cockpit의 무거운 결과 프레임과 달리, 가설 현황을 dot 요약 한 줄로만 보여준다
 * (sentiment 수집을 결과가 압도하지 않도록 — 핸드오프 §3 (A) vs (B) 비교의 핵심 판단).
 */
export function EvidenceStrip({ hypotheses }: { hypotheses: RetroHypothesisResult[] }) {
  const t = useTranslations('retro');
  if (hypotheses.length === 0) return null;

  const verified = hypotheses.filter((h) => h.status === 'verified').length;
  const falsified = hypotheses.filter((h) => h.status === 'falsified').length;
  const measuring = hypotheses.filter((h) => h.status === 'measuring').length;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
      <span className="font-semibold text-foreground">{t('evidenceStripLabel')}</span>
      {verified > 0 ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          <span className="tabular-nums">{verified}</span>
        </span>
      ) : null}
      {falsified > 0 ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 rounded-full bg-info" aria-hidden />
          <span className="tabular-nums">{falsified}</span>
        </span>
      ) : null}
      {measuring > 0 ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 rounded-full border border-dashed border-muted-foreground" aria-hidden />
          <span className="tabular-nums">{measuring}</span>
        </span>
      ) : null}
      <span className="ml-auto text-[10px] text-muted-foreground">{t('evidenceStripMore')}</span>
    </div>
  );
}
