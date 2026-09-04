import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { CHANNEL_POST_VOID_REASON_MESSAGE_KEYS, type FailureAction } from '@/components/content/failure-action';
import { formatScheduledAt } from '@/components/content/schedule-format';

// story #3422 ②-c 2/N(doc §17-13) — 실패 5종 렌더 매핑. 버튼 유무표 그대로:
//   blocked=버튼 없음(연결 고치기로) · needs_check=2단계(확認→재시도) ·
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
}

export function FailureActionBadge({ action, onRetryClick, displayTimezone, compact }: FailureActionBadgeProps) {
  const t = useTranslations('content');

  if (action.kind === 'blocked') {
    return (
      <p className="text-xs text-destructive" data-testid="channel-post-failure-badge">
        {t('channelPostsFailureBlocked')}
      </p>
    );
  }
  if (action.kind === 'needs_check') {
    return (
      <div className="space-y-1" data-testid="channel-post-failure-badge">
        <p className="text-xs text-muted-foreground">{t('channelPostsFailureNeedsCheck')}</p>
        {compact ? null : (
          <>
            <Button
              variant="outline" size="sm" onClick={onRetryClick} disabled={!onRetryClick}
              data-testid="channel-post-failure-retry-button"
            >
              {t('channelPostsFailureCheckedRetryCta')}
            </Button>
            {onRetryClick ? null : (
              <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-retry-disabled-reason">
                {t('channelPostsFailureRetryComingSoon')}
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
    return (
      <div className="space-y-1" data-testid="channel-post-failure-badge">
        <p className="text-xs text-destructive">{t('channelPostsFailureDeadLetter')}</p>
        {compact ? null : (
          <>
            <Button
              variant="outline" size="sm" onClick={onRetryClick} disabled={!onRetryClick}
              data-testid="channel-post-failure-retry-button"
            >
              {t('channelPostsFailureRetryCta')}
            </Button>
            {onRetryClick ? null : (
              <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-retry-disabled-reason">
                {t('channelPostsFailureRetryComingSoon')}
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
