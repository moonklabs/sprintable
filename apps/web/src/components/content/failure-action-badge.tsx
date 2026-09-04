import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { CHANNEL_POST_VOID_REASON_LABELS, type FailureAction } from '@/components/content/failure-action';
import { formatScheduledAt } from '@/components/content/schedule-format';

// story #3422 ②-c 2/N(doc §17-13) — 실패 5종 렌더 매핑. 버튼 유무표 그대로:
//   blocked=버튼 없음(연결 고치기로) · needs_check=2단계(확認→재시도) ·
//   auto_retry=버튼 없음(next_retry_at 표시) · dead_letter=수동 재시도 버튼(휴먼) ·
//   voided=사유만(행동 없음).
// ⚠️버튼 클릭 배선(재시도 API 호출·확認 다이얼로그)은 이 조각 스코프 밖 — 라벨·버튼
// 유무까지만(PR2 ②-a "게이팅만, API는 별도"와 동형 관례).
export interface FailureActionBadgeProps {
  action: FailureAction;
  onRetryClick?: () => void;
  /** B2(페드루 PO 지적, 2026-09-04) — auto_retry의 next_retry_at을 scheduled_at과 같은
   * tz·형식(formatScheduledAt)으로 보인다. schedule-format.ts::resolveDisplayTimezone이
   * 유일한 tz 출처(ChannelPostCard·CalendarGrid와 동형 원칙). */
  displayTimezone: string;
}

export function FailureActionBadge({ action, onRetryClick, displayTimezone }: FailureActionBadgeProps) {
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
        <Button variant="outline" size="sm" onClick={onRetryClick} data-testid="channel-post-failure-retry-button">
          {t('channelPostsFailureCheckedRetryCta')}
        </Button>
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
        <Button variant="outline" size="sm" onClick={onRetryClick} data-testid="channel-post-failure-retry-button">
          {t('channelPostsFailureRetryCta')}
        </Button>
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
  // action.kind === 'voided'. N2(페드루 PO 지적) — command_reason_code 원시값을 그대로
  // 보간하지 않는다(entity-status-labels.ts 규율과 동형: 맵에 있으면 라벨, 없으면 사유
  // 없이 「무효가 됨」— 원시 코드 노출 금지).
  const voidReasonLabel = action.reasonCode ? CHANNEL_POST_VOID_REASON_LABELS[action.reasonCode] : undefined;
  return (
    <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-badge">
      {voidReasonLabel ? t('channelPostsFailureVoidedWithReason', { reason: voidReasonLabel }) : t('channelPostsFailureVoided')}
    </p>
  );
}
