'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * story #2844(loop-closure P1 FE) — goal을 done으로 닫을 때의 outcome 판정 표면.
 * `HypothesisResolveDialog`(#2036, hypotheses/hypothesis-resolve-dialog.tsx)의 3택 확장 —
 * 같은 폼 형태(수치+한 줄 근거, 근거 없이 제출 불가)를 재사용하되 어휘는 독립(#2843 PO 확定):
 * goal.outcome_status는 자동채점(cron)이 이미 쓰는 hit/miss 그대로 — hypothesis의
 * verified/falsified를 수입하면 같은 컬럼에 두 방언이 생긴다. FE 라벨만 「맞았다/틀렸다」.
 *
 * soul-lock(hypothesis-status-badge.tsx §12.1과 동형 정신) — miss(틀렸다)·unmeasurable(측정
 * 불가)은 destructive(빨강) 금지. goal에는 hypothesis의 killed 같은 "돌이킬 수 없는 파괴" 상태
 * 자체가 없어 이 다이얼로그에 빨강을 쓸 자리가 원천적으로 없다 — 전부 info/success 톤.
 *
 * no-fiction(#2843 AC2, PO 문구 확定) — "판정 없이 닫기"는 막지 않되, 침묵 스킵을 허용하지
 * 않는다. 스킵을 고르면 그 결과(unmeasured 마킹+"닫힌 적 없는 루프" 잔류)를 화면이 먼저 말하고
 * 사용자가 그걸 보고 나서 확정한다(스킵도 "확인" 한 번 더 거침 — 실수로 스킵 방지 겸용).
 */
export type GoalOutcomeSubmission =
  | { outcome_status: 'hit' | 'miss'; outcome_result: { actual: number; reason: string } }
  | { outcome_status: 'unmeasurable'; outcome_result: { reason: string } }
  | { skipped: true };

type Step = 'choice' | 'hit' | 'miss' | 'unmeasurable' | 'skip-confirm';

export function GoalOutcomeDialog({
  goalTitle,
  submitting,
  onSubmit,
  onCancel,
}: {
  goalTitle: string;
  submitting: boolean;
  onSubmit: (result: GoalOutcomeSubmission) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('goals');
  const [step, setStep] = useState<Step>('choice');
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');

  const actualNum = actual.trim() === '' ? null : Number(actual);
  const isHitMissStep = step === 'hit' || step === 'miss';
  const canSubmitHitMiss = isHitMissStep && actualNum !== null && !Number.isNaN(actualNum) && reason.trim().length > 0 && !submitting;
  const canSubmitUnmeasurable = step === 'unmeasurable' && reason.trim().length > 0 && !submitting;

  const submitHitMiss = () => {
    if (!canSubmitHitMiss || (step !== 'hit' && step !== 'miss')) return;
    onSubmit({ outcome_status: step, outcome_result: { actual: actualNum as number, reason: reason.trim() } });
  };
  const submitUnmeasurable = () => {
    if (!canSubmitUnmeasurable) return;
    onSubmit({ outcome_status: 'unmeasurable', outcome_result: { reason: reason.trim() } });
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      {/* HypothesisResolveDialog와 동일 규격(유나 확定 규격 재사용) — sm:max-w-lg·max-h-[85vh]. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t('outcomeDialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[30vh] min-h-0 shrink-0 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <p className="text-sm leading-6 text-foreground">{goalTitle}</p>
        </div>

        {step === 'choice' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setStep('hit')}
                className="rounded-xl border border-success-border bg-success-tint px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:brightness-95"
              >
                {t('outcomeChoiceHit')}
              </button>
              {/* miss·unmeasurable = info 톤(destructive 금지, soul-lock 동형). */}
              <button
                type="button"
                onClick={() => setStep('miss')}
                className="rounded-xl border border-info-border bg-info-tint px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:brightness-95"
              >
                {t('outcomeChoiceMiss')}
              </button>
              <button
                type="button"
                onClick={() => setStep('unmeasurable')}
                className="rounded-xl border border-info-border bg-info-tint px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors hover:brightness-95"
              >
                {t('outcomeChoiceUnmeasurable')}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setStep('skip-confirm')}
              className="mt-1 text-left text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t('outcomeSkipLink')}
            </button>
            <DialogFooter className="mt-auto shrink-0">
              <DialogClose render={<Button type="button" variant="ghost" onClick={onCancel}>{t('cancel')}</Button>} />
            </DialogFooter>
          </div>
        ) : isHitMissStep ? (
          <form
            className="flex min-h-0 flex-1 flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); submitHitMiss(); }}
          >
            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="goal-outcome-actual">
                {t('outcomeActualLabel')} <span className="text-muted-foreground">*</span>
              </label>
              <input
                id="goal-outcome-actual"
                type="number"
                inputMode="decimal"
                value={actual}
                onChange={(e) => setActual(e.target.value)}
                autoFocus
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="goal-outcome-reason">
                {t('outcomeReasonLabel')} <span className="text-muted-foreground">*</span>
              </label>
              <input
                id="goal-outcome-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="text-[11px] text-muted-foreground">{t('outcomeReasonHint')}</p>
            </div>
            <DialogFooter className="mt-auto shrink-0">
              <Button type="button" variant="ghost" disabled={submitting} onClick={() => setStep('choice')}>{t('cancel')}</Button>
              <Button type="submit" disabled={!canSubmitHitMiss} className="bg-brand text-brand-foreground hover:bg-brand/90">
                {submitting ? t('saving') : t('outcomeSubmit')}
              </Button>
            </DialogFooter>
          </form>
        ) : step === 'unmeasurable' ? (
          <form
            className="flex min-h-0 flex-1 flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); submitUnmeasurable(); }}
          >
            <div className="shrink-0 space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="goal-outcome-unmeasurable-reason">
                {t('outcomeReasonLabel')} <span className="text-muted-foreground">*</span>
              </label>
              <input
                id="goal-outcome-unmeasurable-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
                placeholder={t('outcomeUnmeasurableReasonHint')}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <DialogFooter className="mt-auto shrink-0">
              <Button type="button" variant="ghost" disabled={submitting} onClick={() => setStep('choice')}>{t('cancel')}</Button>
              <Button type="submit" disabled={!canSubmitUnmeasurable} className="bg-brand text-brand-foreground hover:bg-brand/90">
                {submitting ? t('saving') : t('outcomeSubmit')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          // step === 'skip-confirm' — no-fiction: 결과(unmeasured+루프 잔류)를 먼저 말하고 확認받는다.
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="rounded-lg border border-warning-border bg-warning-tint px-3 py-2 text-xs text-foreground">
              {t('outcomeSkipWarning')}
            </div>
            <DialogFooter className="mt-auto shrink-0">
              <Button type="button" variant="ghost" disabled={submitting} onClick={() => setStep('choice')}>{t('cancel')}</Button>
              <Button type="button" disabled={submitting} onClick={() => onSubmit({ skipped: true })}>
                {submitting ? t('saving') : t('outcomeSkipConfirm')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
