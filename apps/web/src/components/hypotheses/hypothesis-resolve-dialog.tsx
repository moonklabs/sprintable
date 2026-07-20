'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
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
  target: 'verified' | 'falsified';
}

/**
 * story #2036 — 검증 중(measuring) 가설을 사람이 달성/반증으로 닫는 유일한 표면.
 * AC2: 실제 수치 + 한 줄 근거 둘 다 없으면 제출 불가(근거 없는 "달성" 버튼=조직 자기기만 통로).
 * 반증(falsify)도 같은 폼 구조 — soul-lock(§hypothesis-status-badge.tsx): 반증을 실패처럼
 * 취급하는 문구/색 금지, 담담한 "판정 저장" 톤 유지.
 *
 * 유나 가디언 리뷰(PR #2303) 수정요청: 목표 미달 수치를 입력해도 "달성"으로 조용히 저장되는
 * 통로가 있었다 — 목표(target)를 화면에 보여주면서 불일치를 막지 않은 게 문제. 차단하지 않고
 * (측정 방식 변경·정성 판단 등 정당한 override 사유가 있을 수 있음 — 근거 필드가 그 자리)
 * 불일치를 인지시키는 방향으로: 입력값이 현재 판정 조건과 안 맞으면 배너+반대 판정 전환 버튼.
 *
 * AC8(오르테가 PO 판정, hypothesis.py `_VALID_TRANSITIONS`로 확인): measuring→verified|falsified는
 * archived로만 전진하고 active/measuring으로 역전이 불가("새 가설을 만든다") — 되돌릴 수 없는
 * 종결이라 브랜드 블루(Button 기본 variant)를 종결 버튼에 그대로 둔다(유나 리뷰 PASS 확인).
 */
export function HypothesisResolveDialog({
  hypothesis,
  target: initialTarget,
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
  const [verdict, setVerdict] = useState<'verified' | 'falsified'>(initialTarget);
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');

  const actualNum = actual.trim() === '' ? null : Number(actual);
  const canSubmit = actualNum !== null && !Number.isNaN(actualNum) && reason.trim().length > 0 && !submitting;
  const isVerify = verdict === 'verified';

  // 유나 가디언 수정요청 — 입력값이 현재 선택된 판정의 목표 조건과 맞는지. null=판단 불가(입력 전
  // 또는 target 없음), true/false=충족 여부. mismatch면 저장을 막지 않고 배너로만 알린다.
  const meetsTarget = actualNum !== null && !Number.isNaN(actualNum) && typeof md?.target === 'number'
    ? (md.direction === 'down' ? actualNum <= md.target : actualNum >= md.target)
    : null;
  const mismatch = meetsTarget !== null && meetsTarget !== isVerify;

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
            if (canSubmit) onSubmit({ actual: actualNum as number, reason: reason.trim(), target: verdict });
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

          {mismatch ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-tint px-3 py-2 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p>{isVerify ? t('mismatchVerifyWarning') : t('mismatchFalsifyWarning')}</p>
                <button
                  type="button"
                  onClick={() => setVerdict(isVerify ? 'falsified' : 'verified')}
                  className="font-medium underline underline-offset-2"
                >
                  {isVerify ? t('switchToFalsify') : t('switchToVerify')}
                </button>
              </div>
            </div>
          ) : null}

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
