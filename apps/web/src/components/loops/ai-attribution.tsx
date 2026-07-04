'use client';

import { useTranslations } from 'next-intl';
import { Sparkle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export type AiConfidence = 'high' | 'medium' | 'low';

const CONFIDENCE_VARIANT: Record<AiConfidence, 'success' | 'info' | 'warning'> = {
  high: 'success',
  medium: 'info',
  low: 'warning',
};

/**
 * E-LOOP-LEDGER S28 — "Powered by Sprintable" attribution + 확신도 배지(핸드오프 §2, render
 * doc 86a6f061). L2(학습 요약)/L3(참고 제안)/draft(AI 초안) 3종 AI 조력 블록이 공유하는 "한 인격"
 * 컴포넌트 — voice/attribution을 여기 한 곳에서만 관리해 3곳이 갈라지지 않게 한다.
 *
 * confidence/evidenceCount는 optional·null-safe: BE 계약(디디 S28) 미착지 과도기에는 attribution
 * 칩만 뜨고 확신도 배지는 생략(퇴화 없음, S26/S27/S16과 동일 원칙).
 */
export function AiAttributionRow({
  confidence,
  evidenceCount,
}: {
  confidence?: AiConfidence | null;
  evidenceCount?: number | null;
}) {
  const t = useTranslations('loops');
  const label =
    confidence === 'low'
      ? t('aiConfidenceLowLabel')
      : confidence && evidenceCount != null
        ? t('aiConfidenceLabel', { count: evidenceCount, level: t(`aiConfidenceLevel_${confidence}` as 'aiConfidenceLevel_high') })
        : null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[9.5px] font-bold text-primary">
        <Sparkle className="size-2.5" aria-hidden />
        {t('aiAttributionLabel')}
      </span>
      {confidence && label ? (
        <Badge variant={CONFIDENCE_VARIANT[confidence]} className="text-[9px]">{label}</Badge>
      ) : null}
    </div>
  );
}

/** 하단 투명성 라인 — dashed 상단 보더로 attribution 블록과 시각 구분(핸드오프 §2). */
export function AiTransparencyLine({ className }: { className?: string }) {
  const t = useTranslations('loops');
  return (
    <p className={`mt-1.5 border-t border-dashed border-border/70 pt-1.5 text-[9px] text-muted-foreground ${className ?? ''}`}>
      {t('aiTransparencyLine')}
    </p>
  );
}
