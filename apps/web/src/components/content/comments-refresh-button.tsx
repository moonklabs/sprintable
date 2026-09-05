'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

// story #3517(BE #3865 조각①, 유나 §22-10③, PO 確定 2026-09-05) — 수동 재수집.
// 세 갈래를 구분한다(전부 뭉뚱그린 문자열 message 하나로 두면 429/422가 같은 취급을
// 받는다):
//   - rate_limited(429) — 버튼 비활성+버튼 밖 문구("{N}초 뒤에…", Retry-After 없으면
//     "잠시 뒤" — 초를 지어내지 않는다).
//   - unsupported(422 COMMENT_COLLECTION_UNSUPPORTED) — 버튼 자체를 다시는 안 그린다
//     (재시도해도 같은 결과이므로 "네 번째 얼굴"로 고정 — 유나 표현).
//   - generic — 그 외(403·502 등)는 서버 message를 그대로 버튼 밑에 보인다.
export type CommentsRefreshOutcome =
  | { ok: true }
  | { ok: false; kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { ok: false; kind: 'unsupported' }
  | { ok: false; kind: 'generic'; message: string };

export interface CommentsRefreshButtonProps {
  onRefresh: () => Promise<CommentsRefreshOutcome>;
}

export function CommentsRefreshButton({ onRefresh }: CommentsRefreshButtonProps) {
  const t = useTranslations('content');
  const [submitting, setSubmitting] = useState(false);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [rateLimitedSeconds, setRateLimitedSeconds] = useState<number | null | undefined>(undefined); // undefined=제한 없음, null=초 모름, number=그 초
  const [unsupported, setUnsupported] = useState(false);

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

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={submitting || rateLimited}
        onClick={() => void handleClick()}
        data-testid="comments-refresh-button"
      >
        {submitting ? t('commentsRefreshSubmitting') : t('commentsRefreshCta')}
      </Button>
      {/* story #3517(유나 §22-10③) — 429는 버튼 안(disabled 라벨)이 아니라 버튼 밖에
          사유를 둔다(§5-2/§6-2-1과 같은 관례 — disabled 라벨 자체는 WCAG 면제 대상이라
          "왜 안 되는지"는 별도 문구여야 실제로 전달된다). */}
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
