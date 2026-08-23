'use client';

import { useTranslations } from 'next-intl';

interface RouteErrorStateProps {
  reset: () => void;
  error?: Error;
  title?: string;
  description?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  compact?: boolean;
}

export function RouteErrorState({
  reset,
  error,
  title,
  description,
  secondaryHref = '/login',
  secondaryLabel,
  compact = false,
}: RouteErrorStateProps) {
  const t = useTranslations('common');

  return (
    <div className={`flex items-center justify-center ${compact ? 'min-h-[50vh]' : 'min-h-screen bg-background'}`}>
      {/* story #2969 §2 C행(doc proofline-system-layer-2969, PR-6) — rounded-2xl→rounded-lg
          (§1.1 퇴역). 이 표면은 인라인(오버레이 아님·portal/backdrop 없음)이라 shadow-lg
          제거(§1.2, doc 요약행 "route-error(인라인이면 제거)") — border(compact variant는
          이미 있음)만으로 경계. */}
      <div className={`space-y-4 rounded-lg bg-card text-center ${compact ? 'w-full max-w-lg border p-6' : 'w-full max-w-sm border p-8'}`}>
        <div className="space-y-2">
          <p className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-foreground`}>
            {title ?? t('error')}
          </p>
          <p className="text-sm text-muted-foreground">
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
          <a
            href={secondaryHref}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/50"
          >
            {secondaryLabel ?? t('goToLogin')}
          </a>
        </div>
      </div>
    </div>
  );
}
