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
import type { Hypothesis } from '@sprintable/core-storage';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export interface HypothesisResolveResult {
  actual: number;
  reason: string;
}

/**
 * story #2036 — 검증 중(measuring) 가설을 사람이 달성/반증으로 닫는 유일한 표면.
 * AC2: 실제 수치 + 한 줄 근거 둘 다 없으면 제출 불가(근거 없는 "달성" 버튼=조직 자기기만 통로).
 * 반증(falsify)도 같은 폼 구조 — soul-lock(§hypothesis-status-badge.tsx): 반증을 실패처럼
 * 취급하는 문구/색 금지, 담담한 "판정 저장" 톤 유지.
 */
export function HypothesisResolveDialog({
  hypothesis,
  target,
  submitting,
  onSubmit,
  onCancel,
}: {
  hypothesis: Hypothesis;
  target: 'verified' | 'falsified';
  submitting: boolean;
  onSubmit: (result: HypothesisResolveResult) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('hypotheses');
  const md = hypothesis.metric_definition;
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');

  const actualNum = actual.trim() === '' ? null : Number(actual);
  const canSubmit = actualNum !== null && !Number.isNaN(actualNum) && reason.trim().length > 0 && !submitting;
  const isVerify = target === 'verified';

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isVerify ? t('resolveTitleVerify') : t('resolveTitleFalsify')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit({ actual: actualNum as number, reason: reason.trim() });
          }}
        >
          <p className="line-clamp-3 text-sm leading-6 text-foreground">{hypothesis.statement}</p>

          {md?.metric ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              📈 {md.metric} {md.direction === 'down' ? '≤' : '≥'} {fmt(md.target)}
            </p>
          ) : null}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="resolve-actual">
              {t('actualInputLabel')} <span className="text-destructive">*</span>
            </label>
            <input
              id="resolve-actual"
              type="number"
              inputMode="decimal"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              placeholder={t('targetPlaceholder')}
              autoFocus
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="resolve-reason">
              {t('reasonInputLabel')} <span className="text-destructive">*</span>
            </label>
            <input
              id="resolve-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonInputPlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-[11px] text-muted-foreground">{t('reasonHint')}</p>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" disabled={submitting} onClick={onCancel}>{t('cancel')}</Button>} />
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? t('saving') : t('resolveSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
