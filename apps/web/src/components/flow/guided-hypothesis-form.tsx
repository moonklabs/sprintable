'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface GuidedHypothesisValue {
  statement: string;
  metric: string;
  target: number | '';
  direction: 'up' | 'down';
}

const EMPTY: GuidedHypothesisValue = { statement: '', metric: '', target: '', direction: 'up' };

/**
 * story #2543(#2542 FE 이관, 유나 SSOT ae75a8ff) — guided 3부 폼. 형제 HypothesisForm(전체
 * 폼: statement+metric_definition+measure_after 4필드)의 얇은 특수화가 아니라 별도
 * 컴포넌트다 — source 선택·measure_after 날짜가 폼에 없고(BE가 manual·+14일로 보완,
 * IHypothesisRepository.ts 주석) 예시 칩 prefill이 이 폼 고유 기능이라 분기 없이 갈랐다.
 */
export function GuidedHypothesisForm({
  submitting = false,
  onSubmit,
  onCancel,
}: {
  submitting?: boolean;
  onSubmit: (value: { statement: string; metric: string; target: number; direction: 'up' | 'down' }) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('flow');
  const [value, setValue] = useState<GuidedHypothesisValue>(EMPTY);
  const [activeExample, setActiveExample] = useState<string | null>(null);

  const EXAMPLES = [
    {
      key: 'reviewAgent',
      label: t('guidedExampleReviewAgent'),
      statement: t('guidedExampleReviewAgentStatement'),
      metric: t('guidedExampleReviewAgentMetric'),
      target: 5,
      direction: 'down' as const,
    },
    {
      key: 'byoa',
      label: t('guidedExampleByoa'),
      statement: t('guidedExampleByoaStatement'),
      metric: t('guidedExampleByoaMetric'),
      target: 10,
      direction: 'up' as const,
    },
    {
      key: 'conversion',
      label: t('guidedExampleConversion'),
      statement: t('guidedExampleConversionStatement'),
      metric: t('guidedExampleConversionMetric'),
      target: 60,
      direction: 'up' as const,
    },
    {
      key: 'retention',
      label: t('guidedExampleRetention'),
      statement: t('guidedExampleRetentionStatement'),
      metric: t('guidedExampleRetentionMetric'),
      target: 40,
      direction: 'up' as const,
    },
  ];

  const applyExample = (ex: (typeof EXAMPLES)[number]) => {
    setActiveExample(ex.key);
    setValue({ statement: ex.statement, metric: ex.metric, target: ex.target, direction: ex.direction });
  };

  const target = value.target;
  const canSubmit =
    value.statement.trim().length > 0 &&
    value.metric.trim().length > 0 &&
    target !== '' &&
    !Number.isNaN(target) &&
    !submitting;

  return (
    <form
      // story #2062 회귀가드 — overflow 스크롤 컨테이너는 패딩 또는 focus-inset 필수
      // (링 클리핑 방지, verify-focus-inset-coverage.ts). 탭 이동 대상(예시 칩·입력·버튼)이
      // 많은 폼이라 focus-inset으로 안쪽에 링을 그린다.
      className="focus-inset flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit({ statement: value.statement, metric: value.metric, target: Number(target), direction: value.direction });
      }}
    >
      <p className="text-xs text-muted-foreground">{t('guidedFormSubtitle')}</p>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">{t('guidedExampleLabel')}</p>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.key}
              type="button"
              onClick={() => applyExample(ex)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                activeExample === ex.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10',
              )}
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('guidedStatementLabel')}</label>
        <textarea
          rows={2}
          value={value.statement}
          onChange={(e) => { setActiveExample(null); setValue((v) => ({ ...v, statement: e.target.value })); }}
          placeholder={t('guidedStatementPlaceholder')}
          className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('guidedMetricLabel')}</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input
            value={value.metric}
            onChange={(e) => { setActiveExample(null); setValue((v) => ({ ...v, metric: e.target.value })); }}
            placeholder={t('guidedMetricPlaceholder')}
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            type="number"
            inputMode="decimal"
            value={value.target}
            onChange={(e) => { setActiveExample(null); setValue((v) => ({ ...v, target: e.target.value === '' ? '' : Number(e.target.value) })); }}
            placeholder={t('guidedTargetPlaceholder')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary sm:w-24"
          />
          <div className="flex overflow-hidden rounded-xl border border-border">
            {(['up', 'down'] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                onClick={() => { setActiveExample(null); setValue((v) => ({ ...v, direction: dir })); }}
                className={cn(
                  'whitespace-nowrap px-3 py-2 text-xs font-medium transition',
                  value.direction === dir ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                {dir === 'up' ? t('guidedDirUp') : t('guidedDirDown')}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-info">{t('guidedMetricHint')}</p>
      </div>

      <div className="mt-auto flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('guidedCancel')}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? t('guidedSaving') : t('guidedSubmit')}
        </Button>
      </div>
    </form>
  );
}
