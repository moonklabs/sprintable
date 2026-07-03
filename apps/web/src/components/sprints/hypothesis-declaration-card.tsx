'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Hypothesis, HypothesisDraft, MetricDefinition } from '@sprintable/core-storage';
import type { ContextPackSearchResult, HypothesisDeclarationValue } from '@/services/hypothesis-declaration';

const GA4_METRICS = ['activeUsers', 'newUsers', 'sessions', 'conversions', 'eventCount', 'screenPageViews'] as const;
const SOURCES: MetricDefinition['source'][] = ['internal_ops', 'ga4', 'manual'];

/**
 * E-SPRINT-LOOP FE(278314e9) — sprint-open 定 가설 선언 카드 1개. S16 Goal 폼(필수강제+L3 초안)을
 * sprint-level N-선언으로 합성 + L1 선례 조력(S13 어휘) 순증. 모드 토글(새로 정의/기존 링크).
 * SOUL-LOCK: 반증=info "학습"(빨강 금지)·AI 조력<인간 결정(제안형·확정은 유저).
 */
export function HypothesisDeclarationCard({
  projectId,
  contextTitle,
  contextGoal,
  value,
  onChange,
  onRemove,
  linkableHypotheses,
}: {
  projectId: string;
  contextTitle: string;
  contextGoal?: string;
  value: HypothesisDeclarationValue;
  onChange: (v: HypothesisDeclarationValue) => void;
  onRemove?: () => void;
  linkableHypotheses: Hypothesis[] | null;
}) {
  const t = useTranslations('sprints');
  const th = useTranslations('hypotheses');
  const [linkSearch, setLinkSearch] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [precedents, setPrecedents] = useState<ContextPackSearchResult[] | null>(null);
  const [precedentsLoading, setPrecedentsLoading] = useState(false);

  const metric = value.metricDefinition;
  const isGa4 = metric?.source === 'ga4';
  const setMetricPatch = (patch: Partial<NonNullable<HypothesisDeclarationValue['metricDefinition']>>) => {
    const base = metric ?? { metric: '', source: 'internal_ops' as const, target: 0, direction: 'up' as const };
    onChange({ ...value, metricDefinition: { ...base, ...patch } });
  };

  async function handleDraft() {
    setDrafting(true);
    try {
      const res = await fetch('/api/hypotheses/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          source_type: 'loop_goal',
          context: { title: contextTitle, goal: contextGoal ?? null },
          persist: false,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: HypothesisDraft };
        if (json.data?.statement) {
          onChange({ ...value, statement: json.data.statement, drafted: true });
        }
      }
    } catch {
      // 선택 기능 — 실패해도 폼은 그대로 수동 입력 가능(graceful, 퇴화 없음).
    } finally {
      setDrafting(false);
    }
  }

  // L1 선례 — statement 입력을 마친 시점(blur)에 조회. context-pack/search는 BE story a353e88d
  // (PR #1867, crux 중)가 hypothesis_status/outcome_summary를 additive nullable로 얹을 예정 —
  // 지금은 필드 부재/엔드포인트 404 모두 섹션 자체 생략으로 흡수(nullable graceful).
  async function fetchPrecedents() {
    const query = value.statement.trim();
    if (!query || query.length < 4) { setPrecedents(null); return; }
    setPrecedentsLoading(true);
    try {
      const res = await fetch(`/api/context-pack/search?project_id=${projectId}&query=${encodeURIComponent(query)}&limit=5`);
      if (!res.ok) { setPrecedents([]); return; }
      const json = await res.json() as { data?: ContextPackSearchResult[] };
      setPrecedents((json.data ?? []).filter((r) => r.entity_type === 'hypothesis').slice(0, 2));
    } catch {
      setPrecedents([]);
    } finally {
      setPrecedentsLoading(false);
    }
  }

  const filteredLinkable = (linkableHypotheses ?? []).filter((h) =>
    h.statement.toLowerCase().includes(linkSearch.trim().toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-border text-[10px] font-semibold">
          <button
            type="button"
            onClick={() => onChange({ ...value, mode: 'new' })}
            className={cn('px-2.5 py-1 transition', value.mode === 'new' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground')}
          >
            {t('declareModeNew')}
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...value, mode: 'link' })}
            className={cn('px-2.5 py-1 transition', value.mode === 'link' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground')}
          >
            {t('declareModeLink')}
          </button>
        </div>
        {onRemove ? (
          <button type="button" onClick={onRemove} className="text-[10px] text-muted-foreground hover:text-foreground">
            {t('declareRemove')}
          </button>
        ) : null}
      </div>

      {value.mode === 'new' ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">{t('declareStatementLabel')}</span>
            <button
              type="button"
              onClick={() => void handleDraft()}
              disabled={drafting}
              className="inline-flex items-center gap-1 rounded-lg border border-dashed border-border px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-50"
            >
              <Sparkles className="size-3" />
              {drafting ? t('declareDrafting') : t('declareDraftCta')}
            </button>
          </div>
          <textarea
            rows={2}
            value={value.statement}
            onChange={(e) => onChange({ ...value, statement: e.target.value, drafted: false })}
            onBlur={() => void fetchPrecedents()}
            placeholder={t('declareStatementPlaceholder')}
            className={cn(
              'w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40',
              value.drafted ? 'border-primary/40' : 'border-border',
            )}
          />
          {value.drafted ? (
            <p className="flex items-start gap-1.5 rounded-lg border border-dashed border-border bg-info-tint/20 px-2 py-1.5 text-[10px] text-muted-foreground">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-info" aria-hidden />
              <span><b className="text-foreground">{t('declareDraftNoteTitle')}</b> {t('declareDraftNoteBody')}</span>
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <input
              value={metric?.metric ?? ''}
              onChange={(e) => setMetricPatch({ metric: e.target.value })}
              placeholder={th('metricPlaceholder')}
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <select
              value={metric?.source ?? 'internal_ops'}
              onChange={(e) => setMetricPatch({ source: e.target.value as 'internal_ops' | 'ga4' | 'manual' })}
              className="rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>{s === 'ga4' ? th('sourceGa4') : s === 'manual' ? th('sourceManual') : th('sourceInternal')}</option>
              ))}
            </select>
            <div className="flex overflow-hidden rounded-xl border border-border">
              {(['up', 'down'] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setMetricPatch({ direction: dir })}
                  className={cn(
                    'px-3 py-2 text-xs font-medium transition',
                    (metric?.direction ?? 'up') === dir ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {dir === 'up' ? th('dirUp') : th('dirDown')}
                </button>
              ))}
            </div>
            <input
              type="number"
              inputMode="decimal"
              value={metric && !Number.isNaN(metric.target) ? metric.target : ''}
              onChange={(e) => setMetricPatch({ target: e.target.value === '' ? 0 : Number(e.target.value) })}
              placeholder={th('targetPlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 sm:w-20"
            />
          </div>

          {isGa4 ? (
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-2 sm:grid-cols-3">
              <input
                value={metric?.property_id ?? ''}
                onChange={(e) => setMetricPatch({ property_id: e.target.value })}
                placeholder="GA4 property_id"
                className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <select
                value={metric?.ga4_metric ?? ''}
                onChange={(e) => setMetricPatch({ ga4_metric: e.target.value })}
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">ga4_metric</option>
                {GA4_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                type="number"
                inputMode="numeric"
                value={metric?.date_range_days ?? ''}
                onChange={(e) => setMetricPatch({ date_range_days: e.target.value === '' ? undefined : Number(e.target.value) })}
                placeholder={t('declareGa4DateRangePlaceholder')}
                className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          ) : null}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('declareMeasureAfterLabel')}</label>
            <input
              type="date"
              value={value.measureAfter}
              onChange={(e) => onChange({ ...value, measureAfter: e.target.value })}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {precedentsLoading ? (
            <p className="text-[10px] text-muted-foreground">{t('declareL1Loading')}</p>
          ) : precedents && precedents.length > 0 ? (
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-2">
              <p className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                <Sparkles className="size-3 text-info" aria-hidden />
                {t('declareL1Title')}
              </p>
              {precedents.map((p) => (
                <div key={p.entity_id} className="flex items-start gap-2 text-[10.5px]">
                  <span className="mt-0.5 shrink-0 tabular-nums text-muted-foreground">{p.similarity.toFixed(2)}</span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-foreground">{p.embedding_text}</p>
                    {p.hypothesis_status ? (
                      <p className="flex items-center gap-1.5 text-muted-foreground">
                        <Badge variant={p.hypothesis_status === 'verified' ? 'success' : 'info'} className="text-[9px]">
                          {p.hypothesis_status === 'verified' ? t('declareL1Verified') : t('declareL1FalsifiedLearn')}
                        </Badge>
                        {p.outcome_summary ?? null}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="space-y-2">
          <input
            value={linkSearch}
            onChange={(e) => setLinkSearch(e.target.value)}
            placeholder={th('pickerSearch')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          {linkableHypotheses === null ? (
            <p className="py-2 text-center text-xs text-muted-foreground">{t('loading')}</p>
          ) : filteredLinkable.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">{th('pickerEmpty')}</p>
          ) : (
            <div className="max-h-32 space-y-1 overflow-y-auto">
              {filteredLinkable.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => onChange({
                    ...value,
                    linkedHypothesisId: h.id,
                    linkedPreview: { statement: h.statement, metric: h.metric_definition?.metric, status: h.status },
                  })}
                  className={cn(
                    'w-full rounded-lg border px-2.5 py-1.5 text-left text-xs transition',
                    value.linkedHypothesisId === h.id ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:border-primary/40',
                  )}
                >
                  {h.statement}
                </button>
              ))}
            </div>
          )}
          {value.linkedPreview ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-foreground">{value.linkedPreview.statement}</span>
              <Badge variant="chip">{value.linkedPreview.status}</Badge>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
