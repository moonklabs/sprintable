'use client';

import { useTranslations } from 'next-intl';
import { ArrowRight, CheckCircle, Circle, Clock, EyeOff, XCircle } from 'lucide-react';
import type { WorkflowLineStepRun } from '@/components/kanban/types';

/**
 * E-DG S11 ② — GateInbox 라인 컨텍스트 미니블록(display-only).
 * "어디 · 누가 · 언제"(step/route/approver/SLA) — H1 GateEvidence("왜")와 시각·의미 분리(AC④).
 * 데이터 = workflow-line/status active StepRunView. 신규 토큰 0.
 * 갭2 v1: step label = from_status→to_status 파생(config step 정의 라벨은 v2).
 * 갭3 v1: approvers[] row 진척만(quorum 임계·reject policy = v2). row 집합이 분모 시각화.
 */

// SLA 잔여/초과 컴팩트 포맷(2h·3d). 단위는 locale-중립 컴팩트(핸드오프 "마감 2h" 정합).
function formatSlaCompact(due: string): { text: string; overdue: boolean } {
  const ms = new Date(due).getTime() - Date.now();
  const overdue = ms < 0;
  const hours = Math.max(1, Math.round(Math.abs(ms) / 3_600_000));
  const text = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  return { text, overdue };
}

interface ApproverRowProps {
  status: string;
  blocking: boolean;
  name: string;
}

function ApproverRow({ status, blocking, name }: ApproverRowProps) {
  const t = useTranslations('cage');
  const view =
    status === 'approved'
      ? { Icon: CheckCircle, cls: 'text-success', label: t('lineApproverApproved') }
      : status === 'rejected'
        ? { Icon: XCircle, cls: 'text-destructive', label: t('lineApproverRejected') }
        : { Icon: Circle, cls: 'text-muted-foreground', label: t('lineApproverPending') };
  const { Icon } = view;
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <Icon className={`size-3 shrink-0 ${view.cls}`} />
      <span className="truncate text-foreground/90">{name}</span>
      {blocking ? (
        <span className="shrink-0 rounded-sm bg-warning-tint px-1 text-[9px] font-medium uppercase text-warning">
          {t('lineApproverBlocking')}
        </span>
      ) : null}
      <span className={`ml-auto shrink-0 ${view.cls}`}>{view.label}</span>
    </div>
  );
}

interface GateLineContextProps {
  step: WorkflowLineStepRun;
  resolveName: (memberId: string) => string;
  className?: string;
}

export function GateLineContext({ step, resolveName, className }: GateLineContextProps) {
  const t = useTranslations('cage');
  const sla = step.sla_due_at ? formatSlaCompact(step.sla_due_at) : null;

  return (
    <div className={`space-y-1.5 rounded-lg bg-muted/45 px-2.5 py-2 ${className ?? ''}`}>
      {/* step label: from → to 파생(갭2 v1) */}
      <div className="flex items-center gap-1.5 text-[11px]">
        {step.from_status ? (
          <span className="text-muted-foreground">{step.from_status}</span>
        ) : null}
        {step.from_status ? <ArrowRight className="size-3 shrink-0 text-muted-foreground/70" /> : null}
        <span className="font-medium text-foreground">{step.to_status}</span>
      </div>

      {/* route reason */}
      {step.routing_reason ? (
        <p className="text-[11px] text-muted-foreground">{step.routing_reason}</p>
      ) : null}

      {/* SLA: 정시 muted / overdue warning */}
      {sla ? (
        <div
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] ${
            sla.overdue
              ? 'border border-warning-border bg-warning-tint text-warning'
              : 'text-muted-foreground'
          }`}
        >
          <Clock className="size-3 shrink-0" />
          <span>{sla.overdue ? t('lineSlaOverdue', { time: sla.text }) : t('lineSlaDue', { time: sla.text })}</span>
        </div>
      ) : null}

      {/* approvers row 진척(갭3 v1) — row 집합이 분모 시각화 */}
      {step.approvers.length > 0 ? (
        <div className="space-y-1 pt-0.5">
          {step.approvers.map((a) => (
            <ApproverRow
              key={a.member_id}
              status={a.status}
              blocking={a.blocking}
              name={resolveName(a.member_id)}
            />
          ))}
        </div>
      ) : null}

      {/* ⑤ engine_degraded/grandfathered: BE observability_note 렌더(하드코딩X)·null/빈값=중립 폴백 */}
      {step.engine_degraded || step.grandfathered ? (
        <p className="flex items-start gap-1 pt-0.5 text-[10px] text-muted-foreground/80">
          <EyeOff className="mt-0.5 size-3 shrink-0" />
          <span>{step.observability_note?.trim() || t('lineObservabilityFallback')}</span>
        </p>
      ) : null}
    </div>
  );
}
