'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import type { Hypothesis } from '@sprintable/core-storage';
import {
  EMPTY_DECLARATION,
  isDeclarationComplete,
  type HypothesisDeclarationValue,
} from '@/services/hypothesis-declaration';
import { HypothesisDeclarationCard } from './hypothesis-declaration-card';

const LINKABLE_STATUSES = new Set<Hypothesis['status']>(['proposed', 'active']);

/**
 * story 671ea3b8(S4) — 에픽 생성 시 가설 선언 섹션. `sprints/hypothesis-declaration-section.tsx`
 * (E-SPRINT-LOOP FE 278314e9)와 카드 로직(AI 초안·GA4 필드·L1 선례·링크 모드)은 100% 동형 재사용
 * (`hypothesis-declaration-card.tsx` 이 폴더의 것도 그 카드의 카피만 에픽용으로 교체한 사본).
 *
 * ⚠️스프린트와 달리 **하드게이트 없음**(그라운딩 확認 — 에픽엔 `HYPOTHESIS_REQUIRED_FOR_ACTIVATION`
 * 동형 BE 강제가 없다). 그래서 "필수" 배지를 달지 않는다(BE가 강제 안 하는데 강제인 척하면 UI가
 * 거짓말하는 것 — no-fiction). 대신 기본 스텝으로 두되 "나중에 정합니다"로 완전 스킵 가능한
 * 마찰 0 유도만 — doc org-briefing-hypothesis-grammar-blueprint §2.2 step5 그대로.
 */
export function EpicHypothesisDeclarationSection({
  projectId,
  contextTitle,
  contextGoal,
  declarations,
  onChange,
}: {
  projectId: string;
  contextTitle: string;
  contextGoal?: string;
  declarations: HypothesisDeclarationValue[];
  onChange: (v: HypothesisDeclarationValue[]) => void;
}) {
  const t = useTranslations('epics');
  const [linkableHypotheses, setLinkableHypotheses] = useState<Hypothesis[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/hypotheses?project_id=${projectId}`);
        if (!res.ok || cancelled) { if (!cancelled) setLinkableHypotheses([]); return; }
        const json = await res.json() as { data?: Hypothesis[] };
        if (!cancelled) setLinkableHypotheses((json.data ?? []).filter((h) => LINKABLE_STATUSES.has(h.status)));
      } catch {
        if (!cancelled) setLinkableHypotheses([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const declaredCount = declarations.filter(isDeclarationComplete).length;

  function addCard() {
    onChange([...declarations, { ...EMPTY_DECLARATION }]);
  }
  function updateCard(index: number, v: HypothesisDeclarationValue) {
    onChange(declarations.map((d, i) => (i === index ? v : d)));
  }
  function removeCard(index: number) {
    onChange(declarations.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-primary/30 bg-primary/[0.02] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          🎯 {t('declareSectionTitle')}
        </span>
        {declaredCount > 0 ? (
          <span className="text-[10px] font-semibold text-primary">{t('declareCount', { count: declaredCount })}</span>
        ) : null}
      </div>

      {declarations.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-info-border bg-info-tint/20 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Sparkles className="size-3.5 text-info" aria-hidden />
            {t('declareGateQuestion')}
          </p>
          <p className="text-[11px] leading-snug text-muted-foreground">{t('declareGateHint')}</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {declarations.map((d, i) => (
            <HypothesisDeclarationCard
              key={i}
              projectId={projectId}
              contextTitle={contextTitle}
              contextGoal={contextGoal}
              value={d}
              onChange={(v) => updateCard(i, v)}
              onRemove={() => removeCard(i)}
              linkableHypotheses={linkableHypotheses}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addCard}
        className="w-full rounded-xl border border-dashed border-border py-2 text-xs font-medium text-muted-foreground transition hover:border-primary hover:text-primary"
      >
        + {t('declareAddCta')}
      </button>
    </div>
  );
}
