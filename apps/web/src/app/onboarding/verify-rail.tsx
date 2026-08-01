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

/** BE `GET /agents/{id}/verification-status` 응답의 한 단계 원본(라벨 미부여). */
export interface RawStep {
  state: RailState;
  status: RailStatus;
  reason?: string;
}

/**
 * story #2404 후속(2026-08-02, 라이브 재확認 중 발견) — recruiter-client.tsx와
 * onboarding/connect-step.tsx가 각자 이 파싱을 따로 구현했는데, 둘 다 `json.data.steps`를
 * 읽고 있었다. 백엔드(`backend/app/routers/agents.py::agent_verification_status`)는 그런
 * 필드를 준 적이 없다 — 실제 필드명은 `rail`이다(`{"data":{"verified":true,"rail":[...]}}`).
 * `steps`는 항상 undefined였으므로 이 파싱은 «단 한 번도» 실 데이터를 낸 적이 없었다 —
 * 검증이 실제로 성공해도(curl로 직접 확認: verified:true) 화면 레일은 초기 pending에
 * 멈춰 있었다. 두 파일이 같은 파싱을 각자 구현하고 있었던 것 자체가 이 버그가 두 곳에서
 * 동시에 존재하게 된 이유이므로, 여기 하나로 모아 그 재발 경로를 없앤다.
 */
export function parseVerificationRail(json: unknown): RawStep[] | null {
  if (json === null || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  const rail = Array.isArray(data)
    ? data
    : (data as { rail?: unknown } | undefined)?.rail ?? (json as { rail?: unknown }).rail;
  return Array.isArray(rail) ? (rail as RawStep[]) : null;
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
