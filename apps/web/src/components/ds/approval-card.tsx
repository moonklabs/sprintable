'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Card } from './card';
import { Chip } from './chip';
import { Field } from './field';
import { Icon, type IconName } from './icon';
import { Textarea } from './input';

/** 게이트 상태 어휘와 같다(backend GATE_STATUSES: approved · rejected · auto_passed · voided · held) + 설계 문서의 `expired`. `auto_passed`는 사람이 허용한 것이 아니라 시스템이 자동으로 통과시킨 것 — `approved`와 다른 아이콘 · 중립 색이라 «사람이 허용함»으로 읽히지 않는다. */
export type ApprovalResolution = 'approved' | 'rejected' | 'auto_passed' | 'held' | 'voided' | 'expired';

/** 결과 한 줄의 모양 — 아이콘 + 글(색만으로 말하지 않는다). 허용됨만 `done`, 거부됨만 `failed`, 그 밖(보류 · 취소 · 만료)은 중립. */
const RESOLUTION: Record<ApprovalResolution, { icon: IconName; text: string }> = {
  approved: { icon: 'check_circle', text: 'text-ds-done' },
  rejected: { icon: 'cancel', text: 'text-ds-failed' },
  auto_passed: { icon: 'info', text: 'text-ds-ink-2' },
  held: { icon: 'do_not_disturb_on', text: 'text-ds-ink-2' },
  voided: { icon: 'block', text: 'text-ds-ink-2' },
  expired: { icon: 'schedule', text: 'text-ds-ink-2' },
};

/** 보는 사람이 «지금 결정해야 하는» 대기 — 내 손이 필요한 카드(왼쪽 호박 막대). 안 보이는 이름 `needsHandLabel`이 필수다. */
export interface ApprovalPendingAct {
  kind: 'pending';
  view: 'act';
  needsHandLabel: string;
  /** 허용 / 거부 단추 줄(보통 `ApprovalActions`) + 사유 칸(`ApprovalReason`). */
  actions: ReactNode;
}
/** 요청자 · 관찰자 시점의 대기 — 누구를 기다리는지 한 줄 + (요청자는) 다른 사람에게 넘기는 행동 하나. */
export interface ApprovalPendingWaiting {
  kind: 'pending';
  view: 'waiting';
  waitingOn: ReactNode;
  action?: ReactNode;
}
/** 위임으로 밀려났거나 권한이 없는 대기 — 행동 없이 이유 한 줄. */
export interface ApprovalPendingReadonly {
  kind: 'pending';
  view: 'readonly';
  note: ReactNode;
}
export interface ApprovalResolved {
  kind: 'resolved';
  resolution: ApprovalResolution;
  /** 결과 글(예: «허용됨»). */
  statusLabel: string;
  /** «누가 처리했나» 한 줄(남이 처리한 경우만). */
  by?: ReactNode;
  /** 결정 사유. */
  note?: ReactNode;
  /** 결과 뒤 행동(예: 되돌리기). */
  extra?: ReactNode;
}
export interface ApprovalLoading { kind: 'loading'; loadingLabel: string }
export interface ApprovalNotFound { kind: 'not-found'; message: string }
export interface ApprovalLoadError { kind: 'error'; message: string }

export type ApprovalState = ApprovalPendingAct | ApprovalPendingWaiting | ApprovalPendingReadonly | ApprovalResolved | ApprovalLoading | ApprovalNotFound | ApprovalLoadError;

export interface ApprovalCardProps {
  /** 머리 라벨 — «결재 요청». */
  label: string;
  /** 무엇을 승인하나 — 한 줄(길면 줄바꿈). */
  title: ReactNode;
  /** 주면 제목이 단추가 된다(본문 미리보기 열기 등). */
  onTitleClick?: () => void;
  /** 머리글 단계(기본 3) — 채팅 안 카드 여럿을 머리글 이동으로 오갈 수 있게 제목이 머리글이다. */
  level?: 2 | 3 | 4;
  /** 요청자 한 줄(예: «요청: 미르코»). */
  requester?: ReactNode;
  /** 위험 표시 — 아이콘 + 글(`high` 고위험 · `unknown` 판정 못 함). 대기 중에만 의미가 있다. */
  risk?: { level: 'high' | 'unknown'; label: string };
  /** 알림 한 줄(예: «논의가 요청됨») — 카드 안 주의 문구. */
  notice?: ReactNode;
  /** 결정 재료 — 요약 · 질문 · 선택지 · 전제 · 에스컬레이션 등(호출부가 채운다). */
  children?: ReactNode;
  /** 행동이 실패했을 때의 오류 글(`role=alert`). */
  error?: ReactNode;
  state: ApprovalState;
  className?: string;
}

/**
 * UI-3(a9d56577) ApprovalCard — doc §4 #10. «결재 요청» 라벨 · «무엇을 승인하나» 한 줄 · 요청자 · 결정 재료 · 허용 / 거부 · 사유 · 결과(허용됨 · 거부됨 · 만료됨).
 * 모양만 맡는다 — 게이트 조회 · SSE · 서명 흐름 · 되돌리기 같은 동작은 호출부(지금의 `ApprovalRequestCard`)가 그대로 맡고, 글(i18n)도 호출부가 만들어 넣는다.
 * 내 손이 필요한 대기(`pending/act`)만 왼쪽 호박 막대 + 안 보이는 이름이 붙고, 결과는 아이콘 + 글로 말한다.
 */
export function ApprovalCard({ label, title, onTitleClick, level = 3, requester, risk, notice, children, error, state, className }: ApprovalCardProps) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  const body = (
    <div className="flex min-w-0 flex-col gap-2 p-3" data-state={state.kind} data-view={state.kind === 'pending' ? state.view : undefined} aria-busy={state.kind === 'loading' || undefined}>
      <div className="flex items-center gap-1.5 text-ds-small font-semibold text-ds-ink-2">
        <Icon name="fact_check" className="shrink-0" />
        <span>{label}</span>
        {risk && state.kind === 'pending' ? (
          <Chip data-risk={risk.level} tone="neutral" icon="warning" className="ml-auto">
            {risk.label}
          </Chip>
        ) : null}
      </div>

      {state.kind === 'loading' ? (
        <div role="status" aria-label={state.loadingLabel} className="h-8 rounded-ds-control bg-ds-surface-high motion-safe:animate-ds-pulse" />
      ) : state.kind === 'not-found' || state.kind === 'error' ? (
        <p className="text-ds-small text-ds-ink-3">{state.message}</p>
      ) : (
        <>
          <Heading className="m-0 min-w-0 text-ds-card-title font-semibold text-ds-ink break-keep [overflow-wrap:anywhere]">
            {onTitleClick ? (
              // 폰(coarse)에서는 Button이 쥔 누름 영역 44(touch:min-h-ds-touch)를 그대로 둔다 — 한 줄 제목이어도 손가락이 닿는 높이는 ≥ 44. `min-h-0`을 주지 않는다.
              <Button type="button" variant="quiet" onClick={onTitleClick} className="h-auto w-full justify-start whitespace-normal px-0 py-0 text-left text-ds-card-title text-ds-action-text hover:bg-transparent">
                {title}
              </Button>
            ) : (
              title
            )}
          </Heading>
          {requester ? <p className="text-ds-small text-ds-ink-3">{requester}</p> : null}
          {children ? <div className="min-w-0 rounded-ds-control bg-ds-surface-sunk p-2 text-ds-body text-ds-ink [overflow-wrap:anywhere]">{children}</div> : null}
          {notice && state.kind === 'pending' ? <p className="flex items-start gap-1.5 text-ds-small text-ds-ink-2"><Icon name="forum" className="mt-0.5 shrink-0" />{notice}</p> : null}
          {error ? (
            <p role="alert" className="flex items-start gap-1.5 text-ds-small text-ds-failed">
              <Icon name="error" className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          ) : null}

          {state.kind === 'pending' && state.view === 'act' ? <div className="flex flex-col gap-2">{state.actions}</div> : null}
          {state.kind === 'pending' && state.view === 'waiting' ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-ds-small font-semibold text-ds-ink-2">
                <Icon name="schedule" className="shrink-0" />
                <span>{state.waitingOn}</span>
              </p>
              {state.action}
            </div>
          ) : null}
          {state.kind === 'pending' && state.view === 'readonly' ? <p className="text-ds-small text-ds-ink-3">{state.note}</p> : null}

          {state.kind === 'resolved' ? (
            <div className="flex flex-col gap-1">
              <p data-resolution={state.resolution} className={cn('flex items-center gap-1.5 text-ds-small font-semibold', RESOLUTION[state.resolution].text)}>
                <Icon name={RESOLUTION[state.resolution].icon} className="shrink-0" />
                <span>{state.statusLabel}</span>
              </p>
              {state.by ? <p className="text-ds-small text-ds-ink-3">{state.by}</p> : null}
              {state.note ? <p className="text-ds-small text-ds-ink-2 [overflow-wrap:anywhere]">{state.note}</p> : null}
              {state.extra}
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  if (state.kind === 'pending' && state.view === 'act') {
    return (
      <Card tone="needs-hand" toneLabel={state.needsHandLabel} data-slot="ds-approval-card" className={cn('min-w-0 max-w-full', className)}>
        {body}
      </Card>
    );
  }
  return (
    <Card data-slot="ds-approval-card" className={cn('min-w-0 max-w-full', className)}>
      {body}
    </Card>
  );
}

export interface ApprovalActionsProps {
  approveLabel: string;
  rejectLabel: string;
  onApprove: () => void;
  onReject: () => void;
  /** 처리 중인 쪽 — 그 단추는 불러오는 중이고 다른 쪽은 눌리지 않는다. */
  busy?: 'approve' | 'reject';
  /** 둘 다 비활성(예: 근거를 아직 안 읽음). */
  disabled?: boolean;
  /** 보조 행동(논의 요청 · 넘기기 등). */
  children?: ReactNode;
}

/** 허용 / 거부 단추 줄 — 한 줄에 강조는 하나(허용 = 주, 거부 = 보조). 보조 행동은 그 뒤에 보조 모양으로 붙는다. */
export function ApprovalActions({ approveLabel, rejectLabel, onApprove, onReject, busy, disabled = false, children }: ApprovalActionsProps) {
  return (
    <div data-slot="ds-approval-actions" className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="primary" onClick={onApprove} loading={busy === 'approve'} disabled={disabled || busy === 'reject'}>
        {approveLabel}
      </Button>
      <Button type="button" variant="secondary" onClick={onReject} loading={busy === 'reject'} disabled={disabled || busy === 'approve'}>
        {rejectLabel}
      </Button>
      {children}
    </div>
  );
}

export interface ApprovalReasonProps {
  /** 보이는 이름 — 예: «사유(선택)». */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: ReactNode;
  disabled?: boolean;
}

/** 사유 칸 — Field(이름 + 오류) + Textarea. 사유는 선택이라 비어 있어도 허용 · 거부를 막지 않는다(막는 규칙은 호출부). */
export function ApprovalReason({ label, value, onChange, placeholder, error, disabled }: ApprovalReasonProps) {
  return (
    <Field label={label} error={error}>
      {(c) => <Textarea {...c} value={value} disabled={disabled} placeholder={placeholder} rows={2} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}
