'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatScheduledAt } from '@/components/content/schedule-format';

// story #3517(BE #3865 조각①, 유나 §22-10③, PO 確定 2026-09-05) — 수동 재수집.
// 세 갈래를 구분한다(전부 뭉뚱그린 문자열 message 하나로 두면 429/422가 같은 취급을
// 받는다):
//   - rate_limited(429) — 버튼 비활성+버튼 밖 문구("{N}초 뒤에…", Retry-After 없으면
//     "잠시 뒤" — 초를 지어내지 않는다).
//   - unsupported(422 COMMENT_COLLECTION_UNSUPPORTED) — 버튼 자체를 이 마운트에선
//     다시 안 그린다(재시도해도 같은 결과이므로 "네 번째 얼굴"로 고정 — 유나 표현).
//     이 상태는 컴포넌트 로컬(useState)이라 마운트 한정 — 페이지를 새로고침하면
//     되돌아온다. 지속형(다시 마운트해도 안 뜨는) 처리는 조각②의 `comments_supported`
//     필드 몫이다(PO 확定 2026-09-05).
//   - generic — 그 외(403·502 등)는 서버 message를 그대로 버튼 밑에 보인다.
export type CommentsRefreshOutcome =
  | { ok: true }
  | { ok: false; kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { ok: false; kind: 'unsupported' }
  | { ok: false; kind: 'generic'; message: string };

export interface CommentsRefreshButtonProps {
  onRefresh: () => Promise<CommentsRefreshOutcome>;
  /** story #3517 조각②-b(BE #3876 additive, 유나 16회차, PO 確定 2026-09-06) —
   * 목록 응답의 comments_next_allowed_at. 로드 시점에 이미 미래 시각이면(다른
   * 세션이 누른 429 창) 버튼을 눌러보기도 전에 비활성+사유를 보인다 — 429 응답을
   * 받고서야 아는 게 아니라 미리 안다. null/undefined=지금 바로 가능. */
  nextAllowedAt?: string | null;
  /** nextAllowedAt 시각 표시용(다른 절대시각 표시들과 동형 tz). nextAllowedAt이
   * 없으면(uncollected/error 얼굴) 이 prop 자체가 안 넘어온다. */
  displayTimezone?: string;
}

export function CommentsRefreshButton({ onRefresh, nextAllowedAt, displayTimezone }: CommentsRefreshButtonProps) {
  const t = useTranslations('content');
  const [submitting, setSubmitting] = useState(false);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [rateLimitedSeconds, setRateLimitedSeconds] = useState<number | null | undefined>(undefined); // undefined=제한 없음, null=초 모름, number=그 초
  const [unsupported, setUnsupported] = useState(false);
  // story #3517 조각②-b — 로드 시점 창은 컴포넌트 마운트 때 한 번만 판정한다(§22-10③
  // "폴링 금지" 규율의 연장 — 매 렌더마다 Date.now()를 다시 재면 창이 지나는 순간
  // 버튼이 사용자 조작 없이 저절로 풀리는 게 이 429 문구의 취지와 안 맞다. "지금
  // 눌러도 되는지"는 로드 시점 스냅샷 하나로 충분 — 재확인은 다음 로드(새로고침)가 함).
  const [loadTimeBlockedUntil] = useState<Date | null>(() => {
    if (!nextAllowedAt) return null;
    const d = new Date(nextAllowedAt);
    return d.getTime() > Date.now() ? d : null;
  });

  async function handleClick() {
    setSubmitting(true);
    setGenericError(null);
    try {
      const result = await onRefresh();
      if (result.ok) {
        setRateLimitedSeconds(undefined);
        return;
      }
      if (result.kind === 'rate_limited') {
        setRateLimitedSeconds(result.retryAfterSeconds);
      } else if (result.kind === 'unsupported') {
        setUnsupported(true);
      } else {
        setGenericError(result.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // story #3517(유나 §22-10③) — 422 unsupported는 버튼 자체를 다시 안 그린다(재시도가
  // 무의미한 상태를 "누를 수 있는 것처럼" 보이면 안 된다) — 대신 그 사실을 문장으로.
  if (unsupported) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="comments-refresh-unsupported">
        {t('commentsRefreshUnsupported')}
      </p>
    );
  }

  const rateLimited = rateLimitedSeconds !== undefined;
  // story #3517 조각②-b — 로드 시점 창(다른 세션이 누른 429)이 아직 안 지났으면
  // 사람이 한 번도 안 눌렀어도 비활성 — 429 응답을 받아야만 아는 게 아니라 로드
  // 시점에 미리 안다(§5-2와 동형: "그려진 컨트롤은 할 수 있다는 단정"을 지키려면
  // 못 하는 걸 미리 알 때 disabled로 정직하게 시작해야 한다).
  const loadTimeBlocked = loadTimeBlockedUntil !== null;

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={submitting || rateLimited || loadTimeBlocked}
        onClick={() => void handleClick()}
        data-testid="comments-refresh-button"
      >
        {submitting ? t('commentsRefreshSubmitting') : t('commentsRefreshCta')}
      </Button>
      {/* story #3517 조각②-b(유나 16회차, PO 確定 2026-09-06) — 429 문장과 같은
          결(버튼 밖·"{시각}까지" 표현)로 로드 시점 차단 사유를 보인다. */}
      {loadTimeBlocked && displayTimezone ? (
        <p className="text-xs text-muted-foreground" data-testid="comments-refresh-load-time-blocked">
          {t('commentsRefreshBlockedUntil', { time: formatScheduledAt(loadTimeBlockedUntil.toISOString(), displayTimezone).display })}
        </p>
      ) : null}
      {/* story #3517(유나 §22-10③) — 429는 버튼 안(disabled 라벨)이 아니라 버튼 밖에
          사유를 둔다(doc 3653a18c §5-2 채널 연결 화면과 같은 관례 — disabled 라벨
          자체는 WCAG 면제 대상이라 "왜 안 되는지"는 별도 문구여야 실제로 전달된다). */}
      {rateLimited ? (
        <p className="text-xs text-muted-foreground" data-testid="comments-refresh-rate-limited">
          {rateLimitedSeconds !== null
            ? t('commentsRefreshRateLimitedSeconds', { seconds: rateLimitedSeconds })
            : t('commentsRefreshRateLimitedUnknown')}
        </p>
      ) : null}
      {genericError ? (
        <p className="text-xs text-destructive" data-testid="comments-refresh-error">{genericError}</p>
      ) : null}
    </div>
  );
}
