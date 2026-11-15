'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Field } from '@/components/ds/field';
import { Input, Textarea } from '@/components/ds/input';
import { NativeSelect } from '@/components/ds/select';
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
  const tc = useTranslations('common');
  const [value, setValue] = useState<HypothesisFormValue>(initial ?? EMPTY);
  const md = value.metric_definition;
  const setMd = (patch: Partial<MetricDefinition>) =>
    setValue((v) => ({ ...v, metric_definition: { ...v.metric_definition, ...patch } }));

  const canSubmit =
    value.statement.trim().length > 0 && md.metric.trim().length > 0 && value.measure_after.length > 0 && !submitting;

  return (
    // 4909 AC3 (가설 칸 3단계) — the same three fields on the ds parts: each is a ds `Field` (visible name · the control), the inputs are the field layer (ds Input · Textarea · NativeSelect), the buttons are ds Buttons. Values and the submit are untouched.
    <form
      data-testid="hypothesis-form"
      className="space-y-3 rounded-ds-control border border-ds-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit(value);
      }}
    >
      {/* 1. statement */}
      <Field label={t('statementField')}>
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={value.statement}
            onChange={(e) => setValue((v) => ({ ...v, statement: e.target.value }))}
            placeholder={t('statementPlaceholder')}
            className="min-h-0"
          />
        )}
      </Field>

      {/* 2. metric / threshold (one conceptual field) */}
      <Field label={t('metricField')}>
        {(control) => (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <Input
              {...control}
              value={md.metric}
              onChange={(e) => setMd({ metric: e.target.value })}
              placeholder={t('metricPlaceholder')}
            />
            <NativeSelect
              value={md.source}
              onChange={(e) => setMd({ source: e.target.value as MetricDefinition['source'] })}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s === 'ga4' ? t('sourceGa4') : s === 'manual' ? t('sourceManual') : t('sourceInternal')}
                </option>
              ))}
            </NativeSelect>
            <div className="flex gap-1">
              {(['up', 'down'] as const).map((dir) => (
                <Button
                  key={dir}
                  type="button"
                  size="lg"
                  variant={md.direction === dir ? 'primary' : 'secondary'}
                  aria-pressed={md.direction === dir}
                  onClick={() => setMd({ direction: dir })}
                >
                  {dir === 'up' ? t('dirUp') : t('dirDown')}
                </Button>
              ))}
            </div>
            <Input
              type="number"
              inputMode="decimal"
              value={Number.isNaN(md.target) ? '' : md.target}
              onChange={(e) => setMd({ target: e.target.value === '' ? 0 : Number(e.target.value) })}
              placeholder={t('targetPlaceholder')}
              className="tabular-nums sm:w-20"
            />
          </div>
        )}
      </Field>

      {/* 3. measure_after */}
      <Field label={t('measureAfterField')}>
        {(control) => (
          <Input
            {...control}
            type="date"
            value={value.measure_after}
            onChange={(e) => setValue((v) => ({ ...v, measure_after: e.target.value }))}
          />
        )}
      </Field>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="quiet" size="lg" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={!canSubmit}>
          {submitting ? tc('saving') : t('add')}
        </Button>
      </div>
    </form>
  );
}
