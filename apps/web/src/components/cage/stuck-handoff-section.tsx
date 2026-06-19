'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Loader2, RotateCcw } from 'lucide-react';
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

interface StuckHandoffSectionProps {
  storyId: string;
  memberMap?: Record<string, KanbanMember>;
}

export function StuckHandoffSection({ storyId, memberMap = {} }: StuckHandoffSectionProps) {
  const t = useTranslations('cage');
  const [step, setStep] = useState<WorkflowLineStepRun | null>(null);
  const [fallback, setFallback] = useState<FallbackState>('idle');
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

  const btn = {
    idle: { cls: 'bg-destructive text-white hover:bg-destructive/90', Icon: AlertTriangle, label: t('fallbackNotifyOwner'), disabled: false },
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
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
