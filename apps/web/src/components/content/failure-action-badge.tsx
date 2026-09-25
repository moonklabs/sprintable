import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  CHANNEL_POST_BLOCKED_REASON_MESSAGE_KEYS, CHANNEL_POST_DEAD_LETTER_REASON_MESSAGE_KEYS, CHANNEL_POST_VOID_REASON_MESSAGE_KEYS,
  type FailureAction,
} from '@/components/content/failure-action';
import { formatScheduledAt } from '@/components/content/schedule-format';
import { useResetPassed } from '@/components/content/use-reset-passed';

// story #3422 ②-c 2/N(doc §17-13) — 실패 5종 렌더 매핑. 버튼 유무표 그대로:
//   blocked=연결 고치기로(story #4290 까디르 QA ① — 서버가 사람 재시도를 받으면(command_retryable) «다시 시도»도) · needs_check=2단계(확認→재시도) ·
//   auto_retry=버튼 없음(next_retry_at 표시) · dead_letter=수동 재시도 버튼(휴먼) ·
//   voided=사유만(행동 없음).
// B3(페드루 PO, 2026-09-04 13:14Z) — 재시도 «클릭» 배선(재시도 API 호출·확認 다이얼로그)
// 은 BE가 command_id를 아직 응답에 안 실어(openapi 실측) 이 조각 스코프 밖이다. BE
// 노출(story 0e960006) 뒤 FE 배선(story f061c1a3)이 후속. onRetryClick이 안 넘어오면
// (지금 모든 호출부가 그렇다) 버튼을 안 그리거나 눌리는데 no-op으로 두지 않는다 —
// disabled로 두되 사유는 버튼 밖 <p>로 보인다(유나 재판정 — title은 호버 전용이고
// disabled 버튼은 탭 순서 밖이라 title로만 두면 이 사유에 도달할 방법이 없다. AC5 관례
// ·B4의 <p> 사유와 동형 — 이 화면은 비활성 사유를 항상 버튼 밖에 둔다).
export interface FailureActionBadgeProps {
  action: FailureAction;
  onRetryClick?: () => void;
  /** B2(페드루 PO 지적, 2026-09-04) — auto_retry의 next_retry_at을 scheduled_at과 같은
   * tz·형식(formatScheduledAt)으로 보인다. schedule-format.ts::resolveDisplayTimezone이
   * 유일한 tz 출처(ChannelPostCard·CalendarGrid와 동형 원칙). */
  displayTimezone: string;
  /** N3(페드루 PO, 2026-09-04 13:26Z) — ChannelPostCard는 `<Link>`라 그 안에 이 배지의
   * `<Button>`을 그대로 넣으면 인터랙티브 요소가 중첩된다(a>button, 무효 HTML). 카드
   * 소비처는 compact=true로 라벨만 받는다 — 재시도는 상세로 들어가서 한다. */
  compact?: boolean;
  /** story #3402 갭 후속(페드루 PO 지적, 2026-09-10) — needs_check는 unmapped error_code의
   * fail-closed 기본값이라 site_post 외부 발행 명령(`content/[draftId]/page.tsx`)에도
   * 실제로 도달한다. 그 화면엔 확認 다이얼로그·체크리스트 관문 자체가 없어, action.
   * needsRecheck만 보고 배지·CTA를 needs_check 것으로 바꾸면 "없는 관문을 약속"하는
   * 거짓 문면이 된다. 이 prop이 true인 소비처(channel_posts 상세, 실제 관문이 있음)만
   * needsRecheck를 반영 — 기본 false(정직한 일반 dead_letter 문면이 거짓 약속보다 낫다). */
  recheckGate?: boolean;
  /** story #4264 ④(PO 18:07Z) — 승인 필요로 멈춘 글의 뒷문장(무엇을 하면 되는지)을 고르는 사실. 화면이 게이트 상태 · 승인된
   * 예약 시각을 **실제로 받는** 곳만 넘긴다(모르면 안 넘김 → 앞문장만 · 약속 0). `undefined` = 모름, `null` = 없음이 확실함. */
  approvalContext?: BlockedApprovalContext;
  /** story #4304(유나 4654 기록 · PO 08:18Z) — 연결 사유로 멈춘(blocked) 배지에 «연결 확인» 링크를 둔다(댓글 답변과 같은 목적지 ·
   * 같은 낱말). 고칠 길(연결 화면)이 «다시 시도» 앞에 있어야 끊긴 채 다시 눌러 또 막히지 않는다. 호출부가 `useConnectRulesHref`로
   * 구한 주소를 넘긴다(모르면 안 넘김 → 링크 없음). compact(카드 안 · 목록)에선 그리지 않는다(카드 자체가 링크). */
  connectionHref?: string;
}

export interface BlockedApprovalContext {
  gateStatus: string | null | undefined;
  sealedScheduledAt: string | null | undefined;
}

// 근거(PR 4264 본문): 막는 조건 `channel_posts.py` `gate.status != "approved"` · 결재함은 pending 게이트만
// (`approvals-queue.tsx` `/api/gates/inbox?status=pending`) · 승인 훅은 채널 게시 중 예약 글만 새 발행 명령을 만든다
// (`gate_service.py` `if gate.sealed_scheduled_at is None: return`).
// 문장 키는 표 값으로 둔다(죽은 키 가드가 표 값을 소비로 읽는다 — voided · blocked 사유 표와 같은 관례).
const BLOCKED_APPROVAL_NEXT_MESSAGE_KEYS: Record<string, string> = {
  scheduled: 'channelPostsBlockedNextApprovalScheduled',
  scheduledPassed: 'channelPostsBlockedNextApprovalScheduledPassed',
  immediate: 'channelPostsBlockedNextApprovalImmediate',
  resubmit: 'channelPostsBlockedNextResubmit',
};

function blockedApprovalNextKey(ctx: BlockedApprovalContext | undefined): string | undefined {
  if (!ctx) return undefined;
  if (ctx.gateStatus === 'pending') {
    if (ctx.sealedScheduledAt === undefined) return undefined;
    if (!ctx.sealedScheduledAt) return BLOCKED_APPROVAL_NEXT_MESSAGE_KEYS.immediate;
    // PO 18:13Z · 18:20Z — 봉인된 예약 시각이 이미 지났으면 승인 훅이 그 과거 시각으로 명령을 만들고 워커가 다음 tick에 곧바로
    // 집는다(gate_service 승인 훅 · 과거 시각 가드 없음) — «예약이 새로 잡혀요»는 거짓, 앞문장만 두면 «승인 = 곧 나감»을 감춘다.
    // 사실 경고 문장(유나 D).
    if (Date.parse(ctx.sealedScheduledAt) <= Date.now()) return BLOCKED_APPROVAL_NEXT_MESSAGE_KEYS.scheduledPassed;
    return BLOCKED_APPROVAL_NEXT_MESSAGE_KEYS.scheduled;
  }
  if (ctx.gateStatus === 'rejected' || ctx.gateStatus === null) return BLOCKED_APPROVAL_NEXT_MESSAGE_KEYS.resubmit;
  return undefined;
}

export function FailureActionBadge({ action, onRetryClick, displayTimezone, compact, recheckGate, approvalContext, connectionHref }: FailureActionBadgeProps) {
  const t = useTranslations('content');
  // story #3815 — dead_letter가 아닌 다른 kind에선 항상 null(훅은 조건 없이 매
  // 렌더 호출돼야 하므로 이 자리에 둔다 — early return보다 위).
  const reasonResetAt = action.kind === 'dead_letter' ? action.reasonResetAt : null;
  const resetPassed = useResetPassed(reasonResetAt);
  // story #4290(까디르 QA ① · ④) — 재시도를 내미는지는 서버 한 판정 하나: 호출부가 재시도를 넘겼고(onRetryClick) 서버가 false라고
  // 하지 않았을 때(`action.retryable`). 화면이 kind(상태)로 버튼 유무를 따로 가르지 않는다 — blocked(연결을 고친 뒤)도 서버가 받으면 버튼.
  const retryable = 'retryable' in action ? action.retryable : undefined;
  const canOffer = !!onRetryClick && retryable !== false;

  if (action.kind === 'blocked' && action.paused) {
    // story #4305 — 조직 «외부 발행 일시 중지»로 멈춘 것은 연결 문제가 아니다. 머리는 멈춘 이유(compact도) · 상세는 풀리는 길까지(소유자가 풀면
    // 서버가 스스로 다시 올린다 — 사람 재시도 대상 아님(4654) · 버튼 · 연결 링크 없음).
    return (
      <p className="text-xs text-destructive" data-testid="channel-post-failure-badge">
        {t('channelPostsFailurePaused')}
        {compact ? null : <>{' — '}{t('channelPostsFailurePausedResumes')}</>}
      </p>
    );
  }
  if (action.kind === 'blocked' && action.unknownReason) {
    // story #4305 — 사유를 모르는 blocked: 연결이라 말하지 않는 중립 머리 · 링크 없음 · 재시도는 서버 판정대로(버튼은 아래).
    const head = <p className="text-xs text-destructive">{t('channelPostsFailureBlockedUnknown')}</p>;
    if (compact || !canOffer) return <div data-testid="channel-post-failure-badge">{head}</div>;
    return (
      <div className="space-y-1" data-testid="channel-post-failure-badge">
        {head}
        <Button variant="outline" size="sm" onClick={onRetryClick} data-testid="channel-post-failure-retry-button">
          {t('channelPostsFailureRetryCta')}
        </Button>
      </div>
    );
  }
  if (action.kind === 'blocked') {
    // story #4304(유나 확정) — 머리 «연결 문제로 멈춤» ` — ` «연결 확인»(링크) 한 줄 → 아래 «다시 시도»(고치기 → 다시 시도). 링크는 재시도를
    // 못 내밀어도(서버 판정 false) 늘 둔다(댓글 답변과 같음). compact(목록 · 캘린더 · 보드)는 글만(행이 이미 상세 링크).
    const headline = (
      <p className="text-xs text-destructive" data-testid={canOffer && !compact ? undefined : 'channel-post-failure-badge'}>
        {t('channelPostsFailureBlocked')}
        {!compact && connectionHref ? (
          <>
            {' — '}
            <Link href={connectionHref} className="underline" data-testid="channel-post-failure-connection-link">
              {t('channelPostsFailureConnectionCheckLink')}
            </Link>
          </>
        ) : null}
      </p>
    );
    if (compact || !canOffer) return headline;
    return (
      <div className="space-y-1" data-testid="channel-post-failure-badge">
        {headline}
        <Button variant="outline" size="sm" onClick={onRetryClick} data-testid="channel-post-failure-retry-button">
          {t('channelPostsFailureRetryCta')}
        </Button>
      </div>
    );
  }
  if (action.kind === 'needs_check') {
    return (
      <div className="space-y-1" data-testid="channel-post-failure-badge">
        <p className="text-xs text-muted-foreground">{t('channelPostsFailureNeedsCheck')}</p>
        {compact ? null : (
          <>
            <Button
              variant="outline" size="sm" onClick={canOffer ? onRetryClick : undefined} disabled={!canOffer}
              data-testid="channel-post-failure-retry-button"
            >
              {t('channelPostsFailureCheckedRetryCta')}
            </Button>
            {canOffer ? null : (
              <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-retry-disabled-reason">
                {t('channelPostsFailureRetryUnavailable')}
              </p>
            )}
          </>
        )}
      </div>
    );
  }
  if (action.kind === 'auto_retry') {
    // B2(페드루 PO 지적) — ISO 원문을 그대로 보간하던 것을 scheduled_at과 같은
    // formatScheduledAt(...).display로 바꾼다(같은 카드 안에서 두 형식이 섞이던 결함).
    return (
      <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-badge">
        {action.nextRetryAt
          ? t('channelPostsFailureAutoRetryAt', { time: formatScheduledAt(action.nextRetryAt, displayTimezone).display })
          : t('channelPostsFailureAutoRetryUnknown')}
      </p>
    );
  }
  if (action.kind === 'dead_letter') {
    // story #3815(페드루 PO steer②, 2026-09-12 17:34Z) — reason_code→문구는
    // 표(CHANNEL_POST_DEAD_LETTER_REASON_MESSAGE_KEYS, voided 표와 동형 축)로
    // 코드-무관하게 찾는다 — YOUTUBE_QUOTA_EXCEEDED 전용 하드코딩 분기였으면
    // 다음 새 코드(다른 채널 quota·다른 422)가 또 조용히 일반 문구로 뭉개진다.
    // 표에 없는(모르는) reason_code는 기존 needs_check/dead_letter 제네릭 문장
    // 그대로(지어내지 않는다, voided의 "맵에 없으면 사유 없이" 규율과 동형).
    const deadLetterReasonKey = action.reasonCode
      ? CHANNEL_POST_DEAD_LETTER_REASON_MESSAGE_KEYS[action.reasonCode] : undefined;
    // reset_at 기반 재시도 비활성(resetPassed, 위 useState/useEffect)도 코드-
    // 무관 — "언제 풀리는지 아는 사유"라면 그 시각 前엔 눌러도 100% 다시 실패할
    // 게 확定이라 헛수고를 약속하지 않는다(어떤 reason_code든 reason_reset_at이
    // 실리기만 하면 동일하게 적용).
    // story #3402 갭(PO 채택 ㉡, 2026-09-10) — needsRecheck ∧ recheckGate면 문면·CTA
    // 라벨만 needs_check 것(채널 확認 관문)을 쓴다 — reason_code 표에 매치되는
    // 사유가 없을 때만(더 구체적인 사유가 있으면 그쪽이 이긴다). recheckGate=false
    // (기본, site_post 외부 발행 등 실제 관문이 없는 소비처)면 needsRecheck가
    // true여도 일반 dead_letter 문면 그대로 — 없는 관문을 약속하지 않는다.
    // story #4264(유나 권고 · PO 17:26Z) — compact(목록 · 캘린더 카드 · 인사이트)도 «나갔을 수 있음»을 상세와 같은 사실
    // 문장으로 — 이 부류(200 뒤 id 없음 등)를 사람이 처음 보는 자리가 목록이다. compact는 버튼을 안 그리므로(아래) 없는
    // 관문을 약속하지 않는다(문장만).
    const showRecheckWording = !deadLetterReasonKey && action.needsRecheck && (recheckGate || compact);
    const canRetryNow = resetPassed && canOffer;
    const bodyText = deadLetterReasonKey
      ? t(deadLetterReasonKey)
      : (showRecheckWording ? t('channelPostsFailureNeedsCheck') : t('channelPostsFailureDeadLetter'));
    const ctaText = deadLetterReasonKey
      ? t('channelPostsFailureRetryCta')
      : (showRecheckWording ? t('channelPostsFailureCheckedRetryCta') : t('channelPostsFailureRetryCta'));
    return (
      <div className="space-y-1" data-testid="channel-post-failure-badge">
        <p
          className="text-xs text-destructive"
          data-testid={deadLetterReasonKey ? 'channel-post-failure-reason' : undefined}
        >
          {bodyText}
        </p>
        {compact ? null : (
          <>
            <Button
              variant="outline" size="sm" onClick={canRetryNow ? onRetryClick : undefined} disabled={!canRetryNow}
              data-testid="channel-post-failure-retry-button"
            >
              {ctaText}
            </Button>
            {!resetPassed ? (
              <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-retry-disabled-reason">
                {t('channelPostsFailureRetryAfterReset')}
              </p>
            ) : canOffer ? null : (
              <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-retry-disabled-reason">
                {t('channelPostsFailureRetryUnavailable')}
              </p>
            )}
          </>
        )}
      </div>
    );
  }
  if (action.kind === 'processing') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-badge">
        {t('channelPostsFailureProcessing')}
      </p>
    );
  }
  if (action.kind === 'blocked_unapproved') {
    // story #4264 ④ — 사유 문장만 · 버튼 0(compact 여부와 무관). 사유가 비면 승인 필요(4264 전 워커 행).
    const approvalReason = !action.reasonCode || !(action.reasonCode in CHANNEL_POST_BLOCKED_REASON_MESSAGE_KEYS)
      || action.reasonCode === 'EXTERNAL_PUBLISH_APPROVAL_REQUIRED';
    const blockedReasonKey = approvalReason
      ? CHANNEL_POST_BLOCKED_REASON_MESSAGE_KEYS.EXTERNAL_PUBLISH_APPROVAL_REQUIRED
      : CHANNEL_POST_BLOCKED_REASON_MESSAGE_KEYS[action.reasonCode as string];
    const nextKey = approvalReason ? blockedApprovalNextKey(approvalContext) : undefined;
    return (
      <p className="text-xs text-destructive" data-testid="channel-post-failure-badge">
        <span data-testid="channel-post-failure-reason">{t(blockedReasonKey)}</span>
        {nextKey ? <>{' '}<span data-testid="channel-post-failure-next">{t(nextKey)}</span></> : null}
      </p>
    );
  }
  // action.kind === 'voided'. N2(페드루 PO 지적·유나 재판정) — command_reason_code
  // 원시값을 그대로 보간하지 않는다(entity-status-labels.ts 규율과 동형: 맵에 있으면
  // 라벨, 없으면 사유 없이 「무효가 됨」— 원시 코드 노출 금지). 맵은 한글 리터럴이 아니라
  // 메시지 키를 들고, 여기서 t(key)로 풀어야 en 로케일에서 사유만 한글로 남지 않는다.
  const voidReasonKey = action.reasonCode ? CHANNEL_POST_VOID_REASON_MESSAGE_KEYS[action.reasonCode] : undefined;
  return (
    <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-badge">
      {voidReasonKey ? t('channelPostsFailureVoidedWithReason', { reason: t(voidReasonKey) }) : t('channelPostsFailureVoided')}
    </p>
  );
}
