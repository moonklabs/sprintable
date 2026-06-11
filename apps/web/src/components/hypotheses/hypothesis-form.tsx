'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { MetricDefinition } from '@sprintable/core-storage';

export interface HypothesisFormValue {
  statement: string;
  metric_definition: MetricDefinition;
  measure_after: string;
}

const SOURCES: MetricDefinition['source'][] = ['internal_ops', 'ga4', 'manual'];

const EMPTY: HypothesisFormValue = {
  statement: '',
  metric_definition: { metric: '', source: 'internal_ops', target: 0, direction: 'up' },
  measure_after: '',
};

/**
 * Hypothesis create/edit form — the work-about-work-0 lifeline (§1·§4.4·AC3).
 * EXACTLY three manual inputs: statement, metric/threshold, measure_after. Never add
 * a fourth field — status/owner/verdict/links/confidence are all system/AI byproducts.
 */
export function HypothesisForm({
  initial,
  submitting = false,
  onSubmit,
  onCancel,
}: {
  initial?: HypothesisFormValue;
  submitting?: boolean;
  onSubmit: (value: HypothesisFormValue) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('hypotheses');
  const [value, setValue] = useState<HypothesisFormValue>(initial ?? EMPTY);
  const md = value.metric_definition;
  const setMd = (patch: Partial<MetricDefinition>) =>
    setValue((v) => ({ ...v, metric_definition: { ...v.metric_definition, ...patch } }));

  const canSubmit =
    value.statement.trim().length > 0 && md.metric.trim().length > 0 && value.measure_after.length > 0 && !submitting;

  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit(value);
      }}
    >
      {/* 1. statement */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('statementField')}</label>
        <textarea
          rows={2}
          value={value.statement}
          onChange={(e) => setValue((v) => ({ ...v, statement: e.target.value }))}
          placeholder={t('statementPlaceholder')}
          className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      {/* 2. metric / threshold (one conceptual field) */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('metricField')}</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <input
            value={md.metric}
            onChange={(e) => setMd({ metric: e.target.value })}
            placeholder={t('metricPlaceholder')}
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <select
            value={md.source}
            onChange={(e) => setMd({ source: e.target.value as MetricDefinition['source'] })}
            className="rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s === 'ga4' ? t('sourceGa4') : s === 'manual' ? t('sourceManual') : t('sourceInternal')}
              </option>
            ))}
          </select>
          <div className="flex overflow-hidden rounded-xl border border-border">
            {(['up', 'down'] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                onClick={() => setMd({ direction: dir })}
                className={cn(
                  'px-3 py-2 text-xs font-medium transition',
                  md.direction === dir ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                {dir === 'up' ? t('dirUp') : t('dirDown')}
              </button>
            ))}
          </div>
          <input
            type="number"
            inputMode="decimal"
            value={Number.isNaN(md.target) ? '' : md.target}
            onChange={(e) => setMd({ target: e.target.value === '' ? 0 : Number(e.target.value) })}
            placeholder={t('targetPlaceholder')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 sm:w-20"
          />
        </div>
      </div>

      {/* 3. measure_after */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('measureAfterField')}</label>
        <input
          type="date"
          value={value.measure_after}
          onChange={(e) => setValue((v) => ({ ...v, measure_after: e.target.value }))}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          {t('cancel')}
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? t('saving') : t('add')}
        </button>
      </div>
    </form>
  );
}
