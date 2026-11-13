'use client';

import { useTranslations } from 'next-intl';
import { Chip, type ChipProps } from '@/components/ds/chip';
import { cn } from '@/lib/utils';

export type AiConfidence = 'high' | 'medium' | 'low';

/** 확신도 칩 톤(4911 · ds Chip): 높음 = done · 중간 = info · 낮음 = needs-hand(사람이 한 번 더 볼 것). 글이 «확신도 …»를 같이 말한다 — 색만으로 뜻을 싣지 않는다. */
const CONFIDENCE_TONE: Record<AiConfidence, NonNullable<ChipProps['tone']>> = {
  high: 'done',
  medium: 'info',
  low: 'needs-hand',
};

/**
 * E-LOOP-LEDGER S28 — "Powered by Sprintable" attribution + 확신도 칩(핸드오프 §2, render
 * doc 86a6f061). L2(학습 요약)/L3(참고 제안)/draft(AI 초안) 3종 AI 조력 블록이 공유하는 "한 인격"
 * 컴포넌트 — voice/attribution을 여기 한 곳에서만 관리해 3곳이 갈라지지 않게 한다.
 *
 * confidence/evidenceCount는 optional·null-safe: BE 계약(디디 S28) 미착지 과도기에는 attribution
 * 칩만 뜨고 확신도 칩은 생략(퇴화 없음, S26/S27/S16과 동일 원칙).
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
    <div className="flex flex-wrap items-center gap-1.5">
      {/* AI 표시 = info 칩(색 규칙: AI attribution = info) */}
      <Chip tone="info" icon="auto_awesome" data-slot="ai-attribution">{t('aiAttributionLabel')}</Chip>
      {confidence && label ? <Chip tone={CONFIDENCE_TONE[confidence]}>{label}</Chip> : null}
    </div>
  );
}

/** 하단 투명성 라인 — dashed 상단 보더로 attribution 블록과 시각 구분(핸드오프 §2). */
export function AiTransparencyLine({ className }: { className?: string }) {
  const t = useTranslations('loops');
  return (
    <p className={cn('m-0 mt-1.5 border-t border-dashed border-ds-line pt-1.5 text-ds-small text-ds-ink-3', className)}>
      {t('aiTransparencyLine')}
    </p>
  );
}
