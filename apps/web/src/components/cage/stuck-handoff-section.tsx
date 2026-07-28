'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { GateLineContext } from '@/components/cage/gate-line-context';
import { StuckHandoffDetail } from '@/components/cage/stuck-handoff-detail';
import type { KanbanMember, WorkflowLineStatus, WorkflowLineStepRun } from '@/components/kanban/types';

/**
 * E-DG S12 ① — detail drawer "워크플로우 라인 상태" 섹션(story-detail-panel DISPATCH 직후 마운트).
 * handoff_stuck(delivery_status==='timed_out')일 때만 조건부 렌더(평상시 숨김·노이즈 0·boy-scout).
 * 경고 헤더 → S11 GateLineContext 재사용 → StuckHandoffDetail → fallback action(상태머신).
 * 데이터 = S11 per-story workflow-line/status(추가 BE 0). 신규 토큰 0.
 */
type FallbackState = 'idle' | 'notifying' | 'notified' | 'failed';
// story #2272 — 형제(fallback-notify)와 같은 흐름 안의 withdraw. 되돌릴 수 없는 조작이라
// 'confirming' 단계를 둔다(⛔단클릭 바로 실행 금지) — AC5.
type WithdrawState = 'idle' | 'confirming' | 'withdrawing' | 'withdrawn' | 'failed';

interface StuckHandoffSectionProps {
  storyId: string;
  memberMap?: Record<string, KanbanMember>;
}

export function StuckHandoffSection({ storyId, memberMap = {} }: StuckHandoffSectionProps) {
  const t = useTranslations('cage');
  const [step, setStep] = useState<WorkflowLineStepRun | null>(null);
  const [fallback, setFallback] = useState<FallbackState>('idle');
  const [withdraw, setWithdraw] = useState<WithdrawState>('idle');
  const { toasts, addToast, dismissToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stories/${storyId}/workflow-line/status`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<WorkflowLineStatus>) : null))
      .then((ls) => { if (!cancelled) setStep(ls?.active ?? null); })
      .catch(() => { if (!cancelled) setStep(null); });
    return () => { cancelled = true; };
  }, [storyId]);

  // 조건부: handoff_stuck 일 때만(노이즈 0).
  if (!step || step.delivery_status !== 'timed_out') return null;

  const handleFallback = async () => {
    if (fallback === 'notifying' || fallback === 'notified') return; // idempotent·재클릭 방지
    setFallback('notifying');
    try {
      // ⚠️ 갭2: fallback BE 액션 provisional 경로(디디/산티아고 계약 확정 후 정합). idempotent·200/"이미 통지됨"·status 안 되돌림.
      const res = await fetch(`/api/stories/${storyId}/workflow-line/fallback-notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setFallback('notified');
        addToast({ type: 'success', title: t('fallbackNotifySuccess') });
      } else {
        setFallback('failed');
        addToast({ type: 'error', title: t('fallbackNotifyError') });
      }
    } catch {
      setFallback('failed');
      addToast({ type: 'error', title: t('fallbackNotifyError') });
    }
  };

  // story #2272 AC5 — withdraw는 되돌릴 수 없다(BE: run.status='withdrawn'은 terminal, 재개
  // 엔드포인트 없음, gate/approval도 함께 닫힘). 그래서 idle→confirming(경고 노출)→withdrawing
  // 순서를 강제한다 — ⛔"되돌릴 수 없습니다"를 숨기지 않는다.
  const handleWithdraw = async () => {
    if (withdraw === 'withdrawing' || withdraw === 'withdrawn') return;
    if (withdraw !== 'confirming') { setWithdraw('confirming'); return; }
    setWithdraw('withdrawing');
    try {
      const res = await fetch(`/api/stories/${storyId}/workflow-line/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step_run_id: step.id }),
      });
      if (res.ok) {
        setWithdraw('withdrawn');
        addToast({ type: 'success', title: t('withdrawSuccess') });
      } else {
        setWithdraw('failed');
        addToast({ type: 'error', title: t('withdrawError') });
      }
    } catch {
      setWithdraw('failed');
      addToast({ type: 'error', title: t('withdrawError') });
    }
  };

  const btn = {
    idle: { cls: 'bg-destructive text-destructive-foreground hover:bg-destructive/90', Icon: AlertTriangle, label: t('fallbackNotifyOwner'), disabled: false },
    notifying: { cls: 'bg-destructive/10 text-destructive', Icon: Loader2, label: t('fallbackNotifying'), disabled: true },
    notified: { cls: 'bg-muted text-muted-foreground', Icon: Check, label: t('fallbackNotified'), disabled: true },
    failed: { cls: 'border border-destructive text-destructive hover:bg-destructive/10', Icon: RotateCcw, label: t('fallbackRetry'), disabled: false },
  }[fallback];
  const BtnIcon = btn.Icon;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <p className="mb-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">{t('workflowLineContext')}</p>
      <div className="space-y-2.5">
        {/* ⓐ 경고 헤더 */}
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="size-3 shrink-0" />
          <span>{t('lineHandoffStuck')}</span>
        </Badge>
        {/* ⓑ S11 GateLineContext 재사용(무변경) */}
        <GateLineContext step={step} resolveName={(id) => memberMap[id]?.name ?? id.slice(0, 6)} />
        {/* ⓒ StuckHandoffDetail */}
        <StuckHandoffDetail step={step} />
        {/* ⓓ fallback action(상태머신) */}
        <Button
          variant="ghost"
          className={`w-full gap-1.5 ${btn.cls}`}
          disabled={btn.disabled}
          onClick={() => void handleFallback()}
        >
          <BtnIcon className={`size-3.5 shrink-0 ${fallback === 'notifying' ? 'animate-spin' : ''}`} />
          {btn.label}
        </Button>
        {/* story #2272 — ⓔ withdraw(형제 fallback-notify와 같은 흐름). 되돌릴 수 없어 confirm 단계 */}
        {withdraw === 'withdrawn' ? (
          <div className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 shrink-0" />
            {t('withdrawn')}
          </div>
        ) : withdraw === 'confirming' ? (
          <div className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <p className="text-[11px] text-destructive">{t('withdrawIrreversibleWarning')}</p>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" className="flex-1 text-muted-foreground" onClick={() => setWithdraw('idle')}>
                {t('withdrawCancel')}
              </Button>
              <Button variant="ghost" size="sm" className="flex-1 gap-1 text-destructive hover:bg-destructive/10" onClick={() => void handleWithdraw()}>
                <XCircle className="size-3.5 shrink-0" />
                {t('withdrawConfirm')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full gap-1.5 text-muted-foreground hover:text-destructive"
            disabled={withdraw === 'withdrawing'}
            onClick={() => void handleWithdraw()}
          >
            {withdraw === 'withdrawing' ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <XCircle className="size-3.5 shrink-0" />}
            {withdraw === 'withdrawing' ? t('withdrawing') : t('withdrawRequest')}
          </Button>
        )}
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
