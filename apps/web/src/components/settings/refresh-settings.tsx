'use client';

// story 4891 (UI-8 · the notifications tab's tail card · PO 11-10): the interval chips were raw 34 px buttons — on a phone every press is ≥ 44 now (the ds Button's touch floor), the picked one is the primary look + aria-pressed (same values, same handler).
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { INTERVAL_OPTIONS, useRefreshContext } from '@/contexts/refresh-context';

export function RefreshSettings() {
  const { intervalMs, setIntervalMs } = useRefreshContext();
  const t = useTranslations('settings');

  return (
    <div className="flex flex-wrap gap-2" data-testid="refresh-settings">
      {INTERVAL_OPTIONS.map((opt) => (
        <Button
          key={opt.value}
          type="button"
          variant={intervalMs === opt.value ? 'primary' : 'secondary'}
          aria-pressed={intervalMs === opt.value}
          onClick={() => setIntervalMs(opt.value)}
        >
          {t(opt.labelKey)}
        </Button>
      ))}
    </div>
  );
}
