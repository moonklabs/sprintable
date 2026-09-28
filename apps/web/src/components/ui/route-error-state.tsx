'use client';

import { useTranslations } from 'next-intl';

interface RouteErrorStateProps {
  reset: () => void;
  error?: Error;
  title?: string;
  description?: string;
  /** 보조 링크 목적지. 없으면 보조 링크를 안 그린다(story #4217 — 예전 기본값 `/login`은 목적지가 다른 자리에서 거짓 라벨). */
  secondaryHref?: string;
  secondaryLabel?: string;
  compact?: boolean;
  /** 한국어 낱말 단위 줄바꿈(`break-keep`) — 기본 꺼짐(기존 호출부 무변). */
  breakKeep?: boolean;
}

export function RouteErrorState({
  reset,
  error,
  title,
  description,
  secondaryHref,
  secondaryLabel,
  compact = false,
  breakKeep = false,
}: RouteErrorStateProps) {
  const t = useTranslations('common');

  return (
    // story #4221(유나) — compact는 페이지 안 여백 없는 자리에 놓여 390에서 카드가 x=0에 붙었다(모든 compact 호출부 공통) →
    // compact 자체가 좌우 여백을 가진다(호출부 래퍼 금지 — 이중 여백).
    <div className={`flex items-center justify-center ${compact ? 'min-h-[50vh] px-4' : 'min-h-screen bg-background'}`}>
      {/* story #2969 §2 C행(doc proofline-system-layer-2969, PR-6) — rounded-2xl→rounded-lg
          (§1.1 퇴역). 이 표면은 인라인(오버레이 아님·portal/backdrop 없음)이라 shadow-lg
          제거(§1.2, doc 요약행 "route-error(인라인이면 제거)") — border(compact variant는
          이미 있음)만으로 경계. */}
      <div className={`space-y-4 rounded-lg bg-card text-center ${compact ? 'w-full max-w-lg border p-6' : 'w-full max-w-sm border p-8'}`}>
        <div className="space-y-2">
          <p className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-foreground${breakKeep ? ' break-keep' : ''}`}>
            {title ?? t('error')}
          </p>
          <p className={`text-sm text-muted-foreground${breakKeep ? ' break-keep' : ''}`}>
            {description ?? t('errorDescription')}
          </p>
          {error?.message ? <p className="text-xs text-muted-foreground">{error.message}</p> : null}
        </div>
        <div className="flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand/90"
          >
            {t('retry')}
          </button>
          {secondaryHref ? (
            <a
              href={secondaryHref}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/50"
            >
              {secondaryLabel ?? t('goToLogin')}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
