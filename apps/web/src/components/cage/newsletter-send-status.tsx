'use client';

// story #4262(유나 «디자인 확정» 표 · PO 13:39Z · 13:49Z) — 발송 게이트(newsletter_send) 상세의 «발송 상태» 한 줄 + 사람 재시도.
// 판정 · 문장은 채널 포스트와 한 벌이다(`deriveFailureAction` · `FailureActionBadge` · 채널 포스트 상세의 확인 창 · 결과 줄) —
// 같은 판정에 다른 문장을 붙이지 않는다. 새 문장 0.
//
// 상태별(유나 표):
// - 명령 없음 · 대기 · 처리 중(실패 없음) · 완료 → 줄 없음.
// - 일시 실패(재시도 예정) → «{time}에 자동으로 다시 시도해요.»(버튼 없음).
// - dead_letter · needs_check(보냈는지 모름) → 확인 필요 문장 + «확인했어요 · 다시 시도»(체크 뒤 확인).
// - dead_letter · not_sent 등(안 나간 것이 확실함) → «자동 재시도를 멈췄어요.» + «다시 시도».
// - blocked_unapproved + 연결 비활성(`NEWSLETTER_SEND_CONNECTION_UNAVAILABLE`) → «연결 문제로 멈춤» + 연결 화면 링크 + «다시 시도».
// - 그 밖의 blocked_unapproved(게이트 · 캠페인 없음) → «자동 재시도를 멈췄어요.»(버튼 없음 · 따로 다룬다).
// - 조직 일시정지로 멈춘 blocked → 줄 없음(해제하면 서버가 스스로 다시 큐에 올린다).
// 버튼은 사람에게만(재시도 API가 사람 전용). 뉴스레터는 다시 보내면 구독자 전원에게 두 번 가서 확인 창 한 번은 빼지 않는다.

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useConnectRulesHref } from '@/app/dashboard/dashboard-shell';
import { deriveFailureAction, type CommandStatus, type FailureAction } from '@/components/content/failure-action';
import { FailureActionBadge } from '@/components/content/failure-action-badge';
import { postPublicationRetry, PublicationRetryResultLine, withReload, type PublicationRetryResult, type ReloadOutcome } from '@/components/content/publication-retry';
import type { GateItem } from '@/components/kanban/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const CONNECTION_UNAVAILABLE = 'NEWSLETTER_SEND_CONNECTION_UNAVAILABLE';

type View =
  | { kind: 'badge'; action: FailureAction }
  | { kind: 'connection_blocked' };

function viewOf(command: NonNullable<GateItem['newsletter_send_command']>): View | null {
  if (command.status === 'blocked_unapproved') {
    if (command.reason_code === CONNECTION_UNAVAILABLE) return { kind: 'connection_blocked' };
    return { kind: 'badge', action: { kind: 'dead_letter', needsRecheck: false, reasonCode: null, reasonResetAt: null } };
  }
  if (command.status === 'blocked' && command.failure_kind === 'paused') return null;
  const action = deriveFailureAction({
    commandStatus: command.status as CommandStatus,
    failureKind: command.failure_kind,
    nextRetryAt: command.next_attempt_at,
    reasonCode: command.reason_code,
    reasonResetAt: command.reason_reset_at,
  });
  if (!action) return null;
  return { kind: 'badge', action };
}

export interface NewsletterSendStatusProps {
  gate: GateItem;
  orgId: string | null;
  /** 지금 화면의 사람이 사람 멤버인가 — 에이전트 화면엔 상태 줄만 둔다(재시도 API가 사람 전용). */
  isHuman: boolean;
  displayTimezone: string;
  /** 재시도가 받아들여진 뒤(또는 404 · 재시도 대상 아님) 게이트를 다시 읽는다. true = 새 상태를 반영함 · false/예외 = 다시 읽기 실패(이전 상태 유지). */
  /** 게이트를 다시 읽는다 — `{ retryable }`(다시 읽은 발송 명령의 서버 판정)를 돌려주면 404 뒤 결과 줄이 그 값으로 골라진다(story #4290). */
  onRetried?: () => Promise<ReloadOutcome>;
}

export function NewsletterSendStatus({ gate, orgId, isHuman, displayTimezone, onRetried }: NewsletterSendStatusProps) {
  const t = useTranslations('content');
  const tc = useTranslations('common');
  const connectRulesHref = useConnectRulesHref('/organization/channels');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [checklistConfirmed, setChecklistConfirmed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [result, setResult] = useState<PublicationRetryResult | null>(null);

  const command = gate.gate_type === 'newsletter_send' ? gate.newsletter_send_command : null;
  const view = command ? viewOf(command) : null;
  if (!command || !view) return <PublicationRetryResultLine result={result} testId="channel-post-retry-result" />;

  // story #4290 — 버튼은 서버 판정(`command_retryable`)만 본다 — 화면이 상태로 따로 가르면 서버 404와 갈라진다.
  const canRetry = isHuman && !!orgId && command.command_retryable === true;
  const isNeedsCheckGate = view.kind === 'badge' && (
    view.action.kind === 'needs_check' || (view.action.kind === 'dead_letter' && view.action.needsRecheck)
  );
  const openConfirm = () => { setChecklistConfirmed(false); setConfirmOpen(true); };

  // story #4266 — 채널 포스트 · 사이트 글 상세와 같은 공용 규칙: 결과가 무엇이든 확인 창을 닫고 결과 줄 · 404(재시도 대상 아님)는 게이트를
  // 다시 읽고(onRetried) 로케일 문장 · 그 밖의 실패도 서버 원문 대신 로케일 문장.
  const handleRetry = async () => {
    if (!orgId) return;
    setRetrying(true);
    setResult(null);
    try {
      const next = await postPublicationRetry(`/api/organizations/${orgId}/publication-commands/${command.id}/retry`);
      setConfirmOpen(false);
      setChecklistConfirmed(false);
      setResult(onRetried ? await withReload(next, onRetried) : next);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section className="space-y-2" data-testid="newsletter-send-status">
      {view.kind === 'connection_blocked' ? (
        <div className="space-y-1">
          <FailureActionBadge action={{ kind: 'blocked' }} displayTimezone={displayTimezone} />
          <p className="break-keep text-xs text-muted-foreground" data-testid="newsletter-send-connection-reason">
            {t.rich('channelPostsCommandInFlightReasonBlocked', {
              link: (chunks) => <Link href={connectRulesHref} className="underline">{chunks}</Link>,
            })}
          </p>
          {canRetry ? (
            <Button variant="outline" size="sm" onClick={openConfirm} data-testid="channel-post-failure-retry-button">
              {t('channelPostsFailureRetryCta')}
            </Button>
          ) : null}
        </div>
      ) : (
        <FailureActionBadge
          action={view.action} displayTimezone={displayTimezone}
          // 확인 창의 needs_check 관문(체크리스트)이 이 화면에 실제로 있다 — 채널 포스트 상세와 같이 recheckGate.
          recheckGate
          // 사람이 아니거나 재시도 대상이 아니면 버튼 없이 상태 줄만(compact).
          compact={!canRetry}
          onRetryClick={canRetry ? openConfirm : undefined}
        />
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => { setConfirmOpen(next); if (!next) setChecklistConfirmed(false); }}
        title={t('channelPostsRetryConfirmTitle')}
        description={(
          <>
            <span className="block" data-testid="channel-post-retry-confirm-what">
              {isNeedsCheckGate ? t('channelPostsRetryConfirmWhatNeedsCheck') : t('channelPostsRetryConfirmWhatDeadLetter')}
            </span>
            <span className="block" data-testid="channel-post-retry-confirm-reversible">{t('channelPostsRetryConfirmReversible')}</span>
            {isNeedsCheckGate ? (
              <label className="mt-2 flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox" checked={checklistConfirmed}
                  onChange={(e) => setChecklistConfirmed(e.target.checked)}
                  data-testid="channel-post-retry-confirm-checklist"
                />
                {t('channelPostsRetryConfirmChecklist')}
              </label>
            ) : null}
          </>
        )}
        cancelLabel={tc('cancel')}
        confirmLabel={retrying ? t('channelPostsRetryConfirmPendingCta') : t('channelPostsRetryConfirmAction')}
        confirmDisabled={retrying || (isNeedsCheckGate && !checklistConfirmed)}
        destructive={false}
        onConfirm={() => void handleRetry()}
      />
      <PublicationRetryResultLine result={result} testId="channel-post-retry-result" />
    </section>
  );
}
