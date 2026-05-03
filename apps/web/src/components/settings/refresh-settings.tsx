'use client';

import { useTranslations } from 'next-intl';
import { INTERVAL_OPTIONS, useRefreshContext } from '@/contexts/refresh-context';

export function RefreshSettings() {
  const { intervalMs, setIntervalMs } = useRefreshContext();
  const t = useTranslations('settings');

  return (
    <div className="flex flex-wrap gap-2">
      {INTERVAL_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => setIntervalMs(opt.value)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            intervalMs === opt.value
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
          }`}
        >
          {t(opt.labelKey)}
        </button>
      ))}
    </div>
  );
}
