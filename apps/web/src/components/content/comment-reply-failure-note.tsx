'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { formatScheduledAt } from '@/components/content/schedule-format';
import type { FailureAction } from '@/components/content/failure-action';

// story #3544(유나 §22-15, 3517 조각③, PO 確定 2026-09-06) — comment_reply의
// voided 사유는 channel_post와 다른 값(GATE_NOT_APPROVED_OR_RESEALED·
// TARGET_COMMENT_DELETED)이라 CHANNEL_POST_VOID_REASON_MESSAGE_KEYS(failure-
// action.ts)와 별도 맵을 둔다. CONTENT_CHANGED는 이 컬럼을 channel_post류와
// 공유해 이론상 실릴 수 있으나(§22-15 ⚠️ 실측), comment_reply 워커 경로
// (_process_one_comment_reply_command)는 실제로 이 값을 대입하지 않는다 —
// 맵에 없으면 일반 문구로 접힌다(지어내지 않는다).
const COMMENT_REPLY_VOID_REASON_KEYS: Record<string, string> = {
  GATE_NOT_APPROVED_OR_RESEALED: 'commentsReplyFailureResealMismatch',
  TARGET_COMMENT_DELETED: 'commentsReplyFailureCommentDeleted',
};
// §22-15①: 「봉인 불일치」만 다시 상신이 뜻이 있다 — 「대상 댓글 삭제」는 되돌아올
// 수 없는 상태(§22-9와 같은 축)라 액션이 없고, 모르는 사유도 액션 0(아는 척 안 함).
const VOID_REASON_ALLOWS_RESUBMIT = new Set(['GATE_NOT_APPROVED_OR_RESEALED']);

export interface CommentReplyFailureNoteProps {
  /** channel_post와 같은 축(failure-action.ts::deriveFailureAction 재사용 — 신규
   * 발명 0, command_status 우선순위 진리표는 한 곳에서만 산다). */
  action: FailureAction;
  displayTimezone: string;
  /** dead_letter 전용 — publication-commands/{id}/retry(공용 엔드포인트, content_kind
   * 무관, BE 신설 0)를 호출한다. command_id가 없으면(레이스) 호출부가 안 넘긴다. */
  onRetry?: () => Promise<{ ok: true } | { ok: false; errorMessage: string }>;
  /** voided(봉인 불일치) 전용 — 기존 답변 다이얼로그를 새로 연다(재승인이 필요한
   * 전제 자체가 바뀌었으므로 "같은 명령 재시도"가 아니라 "새 답변으로 다시 시작"). */
  onResubmit?: () => void;
}

export function CommentReplyFailureNote({ action, displayTimezone, onRetry, onResubmit }: CommentReplyFailureNoteProps) {
  const t = useTranslations('content');
  const [retrying, setRetrying] = useState(false);
  const [retryOutcome, setRetryOutcome] = useState<'ok' | string | null>(null);

  async function handleRetryClick() {
    if (!onRetry) return;
    setRetrying(true);
    setRetryOutcome(null);
    try {
      const result = await onRetry();
      setRetryOutcome(result.ok ? 'ok' : result.errorMessage);
    } finally {
      setRetrying(false);
    }
  }

  if (action.kind === 'auto_retry') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="comments-item-reply-failure-note">
        {action.nextRetryAt
          ? t('commentsReplyFailureRetrying', { time: formatScheduledAt(action.nextRetryAt, displayTimezone).display })
          : t('commentsReplyFailureRetryingSoon')}
      </p>
    );
  }

  if (action.kind === 'blocked') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="comments-item-reply-failure-note">
        {t.rich('commentsReplyFailureConnectionBlocked', {
          link: (chunks) => <Link href="/organization/channels" className="underline">{chunks}</Link>,
        })}
      </p>
    );
  }

  if (action.kind === 'dead_letter') {
    return (
      <div className="space-y-1" data-testid="comments-item-reply-failure-note">
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">{t('commentsReplyFailureNeedsResubmit')}</p>
          {/* 페드루 PO REQUIRED 1(유나 §22-15 확定, 2026-09-06) — 이 CTA는 이미
              승인된 명령을 다시 큐에 올릴 뿐(재승인 없음)이라 "상신"(§17: 승인
              요청)이라 부르면 거짓이다. voided(봉인 불일치)의 「다시 상신」과
              같은 낱말로 묶으면 두 다른 메커니즘이 한 낱말이 된다 — 전용 키로
              가른다. "다시 시도"도 금지(자동 재시도 문장 「다시 시도합니다」와
              사람이 누르는 이 버튼이 같은 낱말이 되면 헷갈린다). */}
          <Button
            type="button" variant="outline" size="sm" onClick={() => void handleRetryClick()}
            disabled={!onRetry || retrying} data-testid="comments-item-reply-retry-button"
          >
            {t('commentsReplyRetryCta')}
          </Button>
        </div>
        {retryOutcome === 'ok' ? (
          <p className="text-xs text-muted-foreground" data-testid="comments-item-reply-retry-success">{t('commentsReplyRetrySuccess')}</p>
        ) : retryOutcome && retryOutcome !== 'ok' ? (
          <p className="text-xs text-destructive" data-testid="comments-item-reply-retry-error">{retryOutcome}</p>
        ) : null}
      </div>
    );
  }

  // action.kind === 'voided'(comment_reply엔 'needs_check'·'processing' 갈래가
  // 실제로 안 온다 — needs_check는 BE에서 이미 dead_letter로 접히고, processing은
  // IMAGE 컨테이너 전용 축이라 댓글 답변엔 없는 개념이다. 방어적으로 이 두 경우도
  // 여기(일반 문구·액션 0)로 떨어뜨린다 — 지어낸 라벨을 우기지 않는다).
  if (action.kind !== 'voided') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="comments-item-reply-failure-note">
        {t('commentsReplyFailureNeedsResubmit')}
      </p>
    );
  }
  const reasonKey = action.reasonCode ? COMMENT_REPLY_VOID_REASON_KEYS[action.reasonCode] : undefined;
  const allowsResubmit = action.reasonCode != null && VOID_REASON_ALLOWS_RESUBMIT.has(action.reasonCode);
  return (
    <div className="flex items-center gap-2" data-testid="comments-item-reply-failure-note">
      <p className="text-xs text-muted-foreground">{reasonKey ? t(reasonKey) : t('commentsReplyFailureNeedsResubmit')}</p>
      {allowsResubmit ? (
        <Button
          type="button" variant="outline" size="sm" onClick={onResubmit} disabled={!onResubmit}
          data-testid="comments-item-reply-resubmit-button"
        >
          {t('commentsReplyResubmitCta')}
        </Button>
      ) : null}
    </div>
  );
}
