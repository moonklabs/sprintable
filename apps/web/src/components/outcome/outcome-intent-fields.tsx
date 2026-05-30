'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export interface MetricDefinition { metric: string; source: 'internal_ops' | 'ga4' | 'manual'; target: number; direction: 'up' | 'down'; }
export interface OutcomeIntentValue { success_hypothesis: string; metric_definition: MetricDefinition | null; measure_after: string; }
const INTERNAL_METRICS = ['velocity', 'backlog_remaining', 'progress'] as const;

export function OutcomeIntentFields({ value, onChange, defaultOpen = false }:
  { value: OutcomeIntentValue; onChange: (v: OutcomeIntentValue) => void; defaultOpen?: boolean }) {
  const t = useTranslations('outcomeLoop');
  const [open, setOpen] = useState(defaultOpen || !!value.success_hypothesis || !!value.metric_definition);
  const md = value.metric_definition;
  const setMd = (patch: Partial<MetricDefinition>) => {
    const base: MetricDefinition = md ?? { metric: 'velocity', source: 'internal_ops', target: 0, direction: 'up' };
    onChange({ ...value, metric_definition: { ...base, ...patch } });
  };
  if (!open) return (
    <button type="button" onClick={() => setOpen(true)}
      className="w-full rounded-xl border border-dashed border-border py-2.5 text-sm text-muted-foreground transition hover:border-primary hover:text-primary">
      + {t('addIntent')}
    </button>
  );
  const isInternal = !md || md.source === 'internal_ops';
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('intentLabel')}</span>
        <span className="text-[10px] text-muted-foreground">{t('optional')}</span>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('hypothesisField')}</label>
        <textarea rows={2} value={value.success_hypothesis} onChange={(e) => onChange({ ...value, success_hypothesis: e.target.value })}
          placeholder={t('hypothesisPlaceholder')}
          className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40" />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('metricField')}</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <select value={md?.metric ?? 'velocity'} onChange={(e) => setMd({ metric: e.target.value })}
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40">
            {INTERNAL_METRICS.map((m) => <option key={m} value={m}>{t(`metric_${m}` as 'metric_velocity')}</option>)}
          </select>
          <div className="flex overflow-hidden rounded-xl border border-border">
            {(['up', 'down'] as const).map((dir) => (
              <button key={dir} type="button" onClick={() => setMd({ direction: dir })}
                className={cn('whitespace-nowrap px-3 py-2 text-xs font-medium transition',
                  (md?.direction ?? 'up') === dir ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground')}>
                {dir === 'up' ? t('dirUp') : t('dirDown')}
              </button>
            ))}
          </div>
          <input type="number" inputMode="decimal" value={md?.target ?? ''}
            onChange={(e) => setMd({ target: e.target.value === '' ? 0 : Number(e.target.value) })} placeholder={t('targetPlaceholder')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground tabular-nums placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 sm:w-24" />
        </div>
        {!isInternal ? <p className="text-[11px] text-muted-foreground">{t('externalSourceNote')}</p> : null}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('measureAfterField')}</label>
        <input type="date" value={value.measure_after} onChange={(e) => onChange({ ...value, measure_after: e.target.value })}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40" />
        <p className="text-[11px] text-muted-foreground">{t('measureAfterHint')}</p>
      </div>
    </div>
  );
}
