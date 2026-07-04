'use client';

import { Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type RailStatus = 'pending' | 'active' | 'done' | 'failed';

/** OB-2 verification-status 권위 state 키 (1:1·2026-06-25 락). 한글 라벨은 display-only. */
export const RAIL_ORDER = [
  'config_copied',
  'waiting',
  'mcp_reachable',
  'event_delivered',
  'ack',
  'verified',
] as const;

export type RailState = (typeof RAIL_ORDER)[number];

/** E-MCP-OPT S3: 호스팅(http) transport 축소 레일 — event_delivered/ack 없음(구조적으로 불가·BE agent_verify.py). */
export const HTTP_RAIL_ORDER = ['config_copied', 'waiting', 'mcp_reachable', 'verified'] as const;

export interface DisplayStep {
  state: RailState;
  status: RailStatus;
  label: string;
  reason?: string;
}

function StepIcon({ status }: { status: RailStatus }) {
  if (status === 'done') {
    return (
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-success text-white">
        <Check className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-destructive text-white">
        <X className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  if (status === 'active') {
    // active = status 토큰 `info`(진행중)로 spectrum 완성: muted(대기)→info(진행중)→success(완료)/destructive(실패).
    return (
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-info text-info">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      </span>
    );
  }
  return (
    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-dashed border-border" aria-hidden />
  );
}

export function VerifyRail({ steps }: { steps: DisplayStep[] }) {
  const activeStep = steps.find((s) => s.status === 'active');
  const failedStep = steps.find((s) => s.status === 'failed');
  const announce = failedStep?.label ?? activeStep?.label ?? '';

  return (
    <>
      <ol className="relative">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          const statusText =
            step.status === 'done'
              ? '완료'
              : step.status === 'active'
                ? '진행 중'
                : step.status === 'failed'
                  ? '실패'
                  : '대기';
          return (
            <li
              key={step.state}
              className={cn('relative flex gap-3', !isLast && 'pb-5')}
              aria-current={step.status === 'active' ? 'step' : undefined}
            >
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[10px] top-6 bottom-0 w-0.5',
                    step.status === 'done' ? 'bg-success' : 'bg-border',
                  )}
                />
              )}
              <span className="relative z-10 mt-0.5 shrink-0">
                <StepIcon status={step.status} />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p
                  className={cn(
                    'text-sm',
                    step.status === 'done' && 'text-foreground',
                    step.status === 'active' && 'font-medium text-foreground',
                    step.status === 'failed' && 'font-medium text-destructive',
                    step.status === 'pending' && 'text-muted-foreground',
                  )}
                >
                  {step.label}
                  <span className="sr-only"> — {statusText}</span>
                </p>
                {step.status === 'failed' && step.reason && (
                  <div className="mt-1.5 rounded-md border border-destructive/20 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                    {step.reason}
                  </div>
                )}
                {step.status !== 'failed' && step.reason && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{step.reason}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
    </>
  );
}
