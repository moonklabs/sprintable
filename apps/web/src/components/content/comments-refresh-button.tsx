'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

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
//   - generic — 그 외(403·502 등)는 code가 `HUMAN_SAFE_ERROR_MESSAGE_CODES`
//     allowlist(lib/api-error-message.ts, story #3601 페드루 PO 정정 2026-09-07)에
//     있을 때만 서버 message를 그대로 버튼 밑에 보인다 — 목록 밖 code는 message가
//     uuid·내부명·raw exception repr을 담을 수 있어 호출부 자기 폴백(commentsRefreshErrorGeneric)으로 대신 떨어진다.
export type CommentsRefreshOutcome =
  | { ok: true }
  | { ok: false; kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { ok: false; kind: 'unsupported' }
  | { ok: false; kind: 'generic'; message: string };

export interface CommentsRefreshButtonProps {
  onRefresh: () => Promise<CommentsRefreshOutcome>;
  /** story #3517 조각②-b(BE #3876 additive, 유나 16회차, PO 確定 2026-09-06) —
   * 목록 응답의 comments_next_allowed_at 그대로. 로드 시점에 이미 미래 시각이면
   * (다른 세션이 누른 429 창) 버튼을 눌러보기도 전에 비활성+사유를 보인다 — 429
   * 응답을 받고서야 아는 게 아니라 미리 안다. null/undefined=지금 바로 가능. */
  nextAllowedAt?: string | null;
}

// story #3517 조각②-b(유나 16회차 보강, PO 確定 2026-09-06) — 429 rate_limited와
// 로드 시점 차단(comments_next_allowed_at)이 같은 "얼마나 기다려야 하는지" 문구를
// 공유한다. 60초 미만은 초, 60초 이상은 분 단위로 올림(300초=5분이 아니라 "300초
// 뒤"로 보이면 사람이 암산해야 한다 — §17 어휘 원칙의 숫자 버전).
function formatRemainingWait(seconds: number, t: ReturnType<typeof useTranslations>): string {
  if (seconds < 60) return t('commentsRefreshRateLimitedSeconds', { seconds });
  return t('commentsRefreshRateLimitedMinutes', { minutes: Math.ceil(seconds / 60) });
}

export function CommentsRefreshButton({ onRefresh, nextAllowedAt }: CommentsRefreshButtonProps) {
  const t = useTranslations('content');
  const [submitting, setSubmitting] = useState(false);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [rateLimitedSeconds, setRateLimitedSeconds] = useState<number | null | undefined>(undefined); // undefined=제한 없음, null=초 모름, number=그 초
  const [unsupported, setUnsupported] = useState(false);
  // story #3517 조각②-b — 로드 시점 창은 컴포넌트 마운트 때 한 번만 판정한다(§22-10③
  // "폴링 금지" 규율의 연장 — 매 렌더마다 Date.now()를 다시 재면 창이 지나는 순간
  // 버튼이 사용자 조작 없이 저절로 풀리는 게 이 429 문구의 취지와 안 맞다). "지금
  // 눌러도 되는지"는 로드 시점 스냅샷 하나로 충분 — 다음 로드(새로고침)에서는 반드시
  // 다시 계산돼 풀린다(PO 確定).
  const [loadTimeBlockedSeconds, setLoadTimeBlockedSeconds] = useState<number | null>(() => {
    if (!nextAllowedAt) return null;
    const remainingMs = new Date(nextAllowedAt).getTime() - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null;
  });
  // story #3517 조각②-b REQUIRED 1(유나 Design 변경요청, PO 자기정정 2026-09-06) —
  // "타이머는 안 둔다"였던 최초 판단은 «새로고침 없이 페이지에 머무는 사람»을 안
  // 셌다: 창이 지나도 disabled+문구가 그대로 남으면 "할 수 있는데 못 한다"(§22-13③의
  // 뒤집힌 형)다. 만료 시각에 setTimeout 하나로 비활성+문구가 함께 사라진다(카운트다운
  // 재렌더 0 — 매초 재렌더하지 않는다, §22-10③ 폴링 금지와 다른 축). 초 모르는 429
  // ("잠시 뒤")는 잴 값이 없어 타이머 대상이 아니다(그대로 유지).
  const [loadTimeBlockedExpired, setLoadTimeBlockedExpired] = useState(false);
  // story #3517 조각②-b REQUIRED 2(유나 재리뷰·§22-13 마지막 항목, PO 채택
  // 2026-09-06) — 위 초기화는 "마운트 때 한 번"이라 nextAllowedAt prop이 나중에
  // 바뀌어도(재수집 성공 → 목록 재조회 → 새 comments_next_allowed_at, +5분) 안
  // 읽었다 — 창을 «만든 당사자»에게 §22-13①("로드 시점에 미리 안다")이 안 서는
  // 결함이었다(유나 관찰, PO 첫 PASS 때는 비차단으로 봤다가 REQUIRED로 정정).
  // prop "값이 바뀔 때"만 다시 판정한다(매 렌더 Date.now() 재기 X·카운트다운 X).
  useEffect(() => {
    if (!nextAllowedAt) {
      setLoadTimeBlockedSeconds(null);
      setLoadTimeBlockedExpired(false);
      return;
    }
    const remainingMs = new Date(nextAllowedAt).getTime() - Date.now();
    setLoadTimeBlockedSeconds(remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null);
    setLoadTimeBlockedExpired(false);
  }, [nextAllowedAt]);
  useEffect(() => {
    if (loadTimeBlockedSeconds === null) return;
    const timer = setTimeout(() => setLoadTimeBlockedExpired(true), loadTimeBlockedSeconds * 1000);
    return () => clearTimeout(timer);
  }, [loadTimeBlockedSeconds]);
  useEffect(() => {
    if (typeof rateLimitedSeconds !== 'number') return;
    const timer = setTimeout(() => setRateLimitedSeconds(undefined), rateLimitedSeconds * 1000);
    return () => clearTimeout(timer);
  }, [rateLimitedSeconds]);

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
  const loadTimeBlocked = loadTimeBlockedSeconds !== null && !loadTimeBlockedExpired;

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
      {/* story #3517 조각②-b(유나 16회차, PO 確定 2026-09-06) — 429와 같은 문구
          공식(초/분 임계값 formatRemainingWait)으로 로드 시점 차단 사유를 보인다. */}
      {loadTimeBlocked ? (
        <p className="text-xs text-muted-foreground" data-testid="comments-refresh-load-time-blocked">
          {formatRemainingWait(loadTimeBlockedSeconds, t)}
        </p>
      ) : null}
      {/* story #3517(유나 §22-10③) — 429는 버튼 안(disabled 라벨)이 아니라 버튼 밖에
          사유를 둔다(doc 3653a18c §5-2 채널 연결 화면과 같은 관례 — disabled 라벨
          자체는 WCAG 면제 대상이라 "왜 안 되는지"는 별도 문구여야 실제로 전달된다). */}
      {rateLimited ? (
        <p className="text-xs text-muted-foreground" data-testid="comments-refresh-rate-limited">
          {rateLimitedSeconds !== null
            ? formatRemainingWait(rateLimitedSeconds, t)
            : t('commentsRefreshRateLimitedUnknown')}
        </p>
      ) : null}
      {genericError ? (
        <p className="text-xs text-destructive" data-testid="comments-refresh-error">{genericError}</p>
      ) : null}
    </div>
  );
}
