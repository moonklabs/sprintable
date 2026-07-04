'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Hypothesis } from '@sprintable/core-storage';
import {
  EMPTY_DECLARATION,
  isDeclarationComplete,
  type HypothesisDeclarationValue,
} from '@/services/hypothesis-declaration';
import { HypothesisDeclarationCard } from './hypothesis-declaration-card';

const LINKABLE_STATUSES = new Set<Hypothesis['status']>(['proposed', 'active']);

/**
 * E-SPRINT-LOOP FE(278314e9) — sprint-open 定 가설 선언 섹션(N카드). 핵심 톤 = "이 스프린트로
 * 무엇을 검증하나"는 질문 안내지 마찰 아님(핸드오프 §3). 활성화(定)만 ≥1(생존) 강제 — 이 섹션
 * 자체는 0개도 허용(임시저장 자유·§9-3).
 */
export function HypothesisDeclarationSection({
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
  const t = useTranslations('sprints');
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
          🎯 {t('declareSectionTitle')} <span className="text-destructive">*</span>
          <Badge variant="info" className="font-semibold">{t('declareRequiredBadge')}</Badge>
        </span>
        <span className="text-[10px] font-semibold text-primary">{t('declareCount', { count: declaredCount })}</span>
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
              onRemove={declarations.length > 0 ? () => removeCard(i) : undefined}
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
