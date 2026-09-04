import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { FailureAction } from '@/components/content/failure-action';

// story #3422 ②-c 2/N(doc §17-13) — 실패 5종 렌더 매핑. 버튼 유무표 그대로:
//   blocked=버튼 없음(연결 고치기로) · needs_check=2단계(확認→재시도) ·
//   auto_retry=버튼 없음(next_retry_at 표시) · dead_letter=수동 재시도 버튼(휴먼) ·
//   voided=사유만(행동 없음).
// ⚠️버튼 클릭 배선(재시도 API 호출·확認 다이얼로그)은 이 조각 스코프 밖 — 라벨·버튼
// 유무까지만(PR2 ②-a "게이팅만, API는 별도"와 동형 관례).
export interface FailureActionBadgeProps {
  action: FailureAction;
  onRetryClick?: () => void;
}

export function FailureActionBadge({ action, onRetryClick }: FailureActionBadgeProps) {
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
    return (
      <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-badge">
        {action.nextRetryAt
          ? t('channelPostsFailureAutoRetryAt', { time: action.nextRetryAt })
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
  // action.kind === 'voided'
  return (
    <p className="text-xs text-muted-foreground" data-testid="channel-post-failure-badge">
      {action.reasonCode ? t('channelPostsFailureVoidedWithReason', { reason: action.reasonCode }) : t('channelPostsFailureVoided')}
    </p>
  );
}
