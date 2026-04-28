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
      <div className={`space-y-4 rounded-2xl bg-white text-center shadow-lg ${compact ? 'w-full max-w-lg border p-6' : 'w-full max-w-sm p-8'}`}>
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
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
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
