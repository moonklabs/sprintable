'use client';

import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import type { WorkflowLineStepRun } from '@/components/kanban/types';

/**
 * E-DG S12 ①ⓒ — stuck handoff 디테일(display-only). detail drawer stuck 섹션 전용.
 * 막힌 agent(갭1·BE recipient_agent 미노출 시 "에이전트" 폴백)·last_event 미니박스·delivery_error 박스.
 * 데이터 = S11 per-story workflow-line/status active StepRunView(추가 BE 0). 신규 토큰 0.
 */
interface StuckHandoffDetailProps {
  step: WorkflowLineStepRun;
}

export function StuckHandoffDetail({ step }: StuckHandoffDetailProps) {
  const t = useTranslations('cage');
  const ev = step.last_event;

  return (
    <div className="space-y-2">
      {/* 막힌 agent (갭1: name 있으면 표기·없으면 "에이전트" 폴백) */}
      <p className="text-[11px] text-foreground/90">
        <span className="text-muted-foreground">{t('stuckAgent')}: </span>
        {step.recipient_agent?.name ?? t('agentFallback')}
      </p>

      {/* last_event 미니박스 */}
      {ev ? (
        <div className="space-y-0.5 rounded-md bg-muted/30 px-2 py-1.5 text-[10px] text-muted-foreground">
          <p className="font-medium text-foreground/80">{t('lastEventInfo')}</p>
          <p>{ev.event_type}</p>
          <p className="font-mono">#{ev.id.slice(0, 8)}{ev.recipient_seq != null ? ` · seq ${ev.recipient_seq}` : ''}</p>
          {ev.created_at ? <p>{new Date(ev.created_at).toLocaleString()}</p> : null}
        </div>
      ) : null}

      {/* delivery_error 박스(있을 때만) */}
      {step.delivery_error ? (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive/85">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span>
            <span className="text-destructive/70">{t('deliveryError')}: </span>
            <span className="font-mono">{step.delivery_error}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
