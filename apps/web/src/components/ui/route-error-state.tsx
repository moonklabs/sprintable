'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { ErrorState } from '@/components/ds/error-state';

interface RouteErrorStateProps {
  reset: () => void;
  error?: Error;
  title?: string;
  description?: string;
  /** 보조 링크 목적지. 없으면 보조 링크를 안 그린다(story #4217 — 예전 기본값 `/login`은 목적지가 다른 자리에서 거짓 라벨). */
  secondaryHref?: string;
  secondaryLabel?: string;
  compact?: boolean;
  /** 한국어 낱말 단위 줄바꿈 — `ErrorState`가 늘 하므로 이제 효과 없음(호출부 무변을 위해 받기만 한다). */
  breakKeep?: boolean;
}

/**
 * story 5048 ⑤-⑥ — 길(라우트) 오류 경계의 한 모양: ds `ErrorState`(옛: 손으로 그린 테두리 카드 + raw `<button>` + `bg-brand`).
 * 바깥 틀(전체 화면 `min-h-screen` · compact `min-h-[50vh]` + 좌우 여백 16 — story #4221)과 API는 그대로 — 호출부 5곳은 안 건드린다.
 * 다시 시도 = `reset` · 보조 링크 = 실제 목적지(조용한 ds 단추 · `<a>`).
 */
export function RouteErrorState({
  reset,
  error,
  title,
  description,
  secondaryHref,
  secondaryLabel,
  compact = false,
}: RouteErrorStateProps) {
  const t = useTranslations('common');

  return (
    <div className={`flex items-center justify-center ${compact ? 'min-h-[50vh] px-4' : 'min-h-screen bg-ds-background'}`}>
      <ErrorState
        title={title ?? t('error')}
        description={(
          <>
            {description ?? t('errorDescription')}
            {error?.message ? <span className="mt-1 block text-micro text-ds-ink-3">{error.message}</span> : null}
          </>
        )}
        onRetry={reset}
      >
        {secondaryHref ? (
          <Button asChild variant="quiet">
            <a href={secondaryHref}>{secondaryLabel ?? t('goToLogin')}</a>
          </Button>
        ) : null}
      </ErrorState>
    </div>
  );
}
