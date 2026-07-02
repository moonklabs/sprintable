'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import type { Hypothesis, HypothesisDraft, MetricDefinition } from '@sprintable/core-storage';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** BE _GA4_SUPPORTED_METRICS(backend/app/schemas/story.py)와 동기 — 모르는 지표는 BE가 422. */
const GA4_METRICS = ['activeUsers', 'newUsers', 'sessions', 'conversions', 'eventCount', 'screenPageViews'] as const;
const SOURCES: MetricDefinition['source'][] = ['internal_ops', 'ga4', 'manual'];
const LINKABLE_STATUSES = new Set<Hypothesis['status']>(['proposed', 'active']);

const EMPTY_METRIC: MetricDefinition = { metric: '', source: 'internal_ops', target: 0, direction: 'up' };

type Mode = 'new' | 'link';

/**
 * E-LOOP-LEDGER S16 — net-new loop 생성 모달(핸드오프 §1/§2, render doc ec26cd28).
 * Goal(hypothesis) 필수 강제: trio(statement+metric_definition+measure_after) 또는
 * 기존 hypothesis_id 링크 — 하나도 없으면 BE가 LOOP_HYPOTHESIS_REQUIRED(400).
 *
 * S15 자동초안("AI 초안 제안") — 디디 BE #1850(source_type="loop_goal", source_id 불요)로
 * loop-create처럼 백킹 엔티티가 없는 맥락에서도 draft 가능. "돕되 대체 안 함"(핸드오프 §3):
 * persist=false 미리보기만 받아 statement 필드를 편집가능 상태로 채운다 — 자동 submit 없음,
 * 확정은 항상 유저의 "Loop 생성" 클릭. gen-LLM 미가용/실패는 BE가 deterministic 템플릿으로
 * graceful fallback(S15 #1847)하므로 이 버튼은 실패해도 폼을 막지 않는다(선택 기능).
 */
export function LoopCreateDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (loop: { id: string }) => void;
}) {
  const t = useTranslations('loops');
  const th = useTranslations('hypotheses');

  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<Mode>('new');
  const [statement, setStatement] = useState('');
  const [metric, setMetric] = useState<MetricDefinition>(EMPTY_METRIC);
  const [measureAfter, setMeasureAfter] = useState('');
  const [tags, setTags] = useState('');

  const [hypotheses, setHypotheses] = useState<Hypothesis[] | null>(null);
  const [hypothesisSearch, setHypothesisSearch] = useState('');
  const [linkedId, setLinkedId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState(false);

  const reset = useCallback(() => {
    setTitle('');
    setMode('new');
    setStatement('');
    setMetric(EMPTY_METRIC);
    setMeasureAfter('');
    setTags('');
    setLinkedId(null);
    setHypothesisSearch('');
    setError(null);
    setDrafted(false);
  }, []);

  const handleDraft = useCallback(async () => {
    setDrafting(true);
    try {
      const res = await fetch('/api/hypotheses/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          source_type: 'loop_goal',
          context: title.trim() ? { title: title.trim() } : null,
          persist: false,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: HypothesisDraft };
        if (json.data?.statement) {
          setStatement(json.data.statement);
          setDrafted(true);
        }
      }
    } catch {
      // 선택 기능 — 실패해도 폼은 그대로 수동 입력 가능(graceful, 퇴화 없음).
    } finally {
      setDrafting(false);
    }
  }, [projectId, title]);

  useEffect(() => {
    if (!open) return;
    if (mode !== 'link' || hypotheses !== null) return;
    void (async () => {
      try {
        const res = await fetch(`/api/hypotheses?project_id=${projectId}`);
        if (!res.ok) { setHypotheses([]); return; }
        const json = (await res.json()) as { data?: Hypothesis[] };
        setHypotheses((json.data ?? []).filter((h) => LINKABLE_STATUSES.has(h.status)));
      } catch {
        setHypotheses([]);
      }
    })();
  }, [open, mode, hypotheses, projectId]);

  const setMetricPatch = (patch: Partial<MetricDefinition>) => setMetric((m) => ({ ...m, ...patch }));

  const isGa4 = metric.source === 'ga4';
  const goalComplete =
    mode === 'link'
      ? linkedId !== null
      : statement.trim().length > 0 &&
        metric.metric.trim().length > 0 &&
        measureAfter.length > 0 &&
        (!isGa4 || (!!metric.property_id?.trim() && !!metric.ga4_metric && !!metric.date_range_days));

  const canSubmit = title.trim().length > 0 && goalComplete && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        project_id: projectId,
        title: title.trim(),
        goal_tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (mode === 'link') {
        body['hypothesis_id'] = linkedId;
      } else {
        body['goal'] = statement.trim();
        body['metric_definition'] = isGa4
          ? metric
          : { metric: metric.metric, source: metric.source, target: metric.target, direction: metric.direction };
        body['measure_after'] = new Date(measureAfter).toISOString();
      }
      const res = await fetch('/api/loops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const loop = (await res.json()) as { id: string };
        reset();
        onOpenChange(false);
        onCreated(loop);
        return;
      }
      const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      if (json?.error?.code === 'LOOP_HYPOTHESIS_REQUIRED') {
        setError(t('createLoopErrorHypothesisRequired'));
      } else {
        setError(json?.error?.message ?? t('createLoopErrorGeneric'));
      }
    } catch {
      setError(t('createLoopErrorGeneric'));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, projectId, title, tags, mode, linkedId, statement, isGa4, metric, measureAfter, reset, onOpenChange, onCreated, t]);

  const filteredHypotheses = (hypotheses ?? []).filter((h) =>
    h.statement.toLowerCase().includes(hypothesisSearch.trim().toLowerCase()),
  );
  const linkedHypothesis = hypotheses?.find((h) => h.id === linkedId) ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('createLoopTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t('createLoopFormTitleLabel')} <span className="text-destructive">*</span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('createLoopFormTitlePlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          <div className="space-y-2.5 rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">
                {t('createLoopGoalLabel')} <span className="text-destructive">*</span>
              </span>
              <div className="flex overflow-hidden rounded-lg border border-border text-[10.5px] font-semibold">
                <button
                  type="button"
                  onClick={() => setMode('new')}
                  className={cn('px-2.5 py-1 transition', mode === 'new' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground')}
                >
                  {t('createLoopModeNew')}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('link')}
                  className={cn('px-2.5 py-1 transition', mode === 'link' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground')}
                >
                  {t('createLoopModeLink')}
                </button>
              </div>
            </div>

            {mode === 'new' ? (
              <>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">
                      {t('createLoopStatementLabel')} <span className="text-destructive">*</span>
                    </label>
                    {!drafted ? (
                      <button
                        type="button"
                        onClick={() => void handleDraft()}
                        disabled={drafting}
                        className="inline-flex items-center gap-1 rounded-lg border border-dashed border-border px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-50"
                      >
                        <Sparkles className="size-3" />
                        {drafting ? t('createLoopDrafting') : t('createLoopDraftCta')}
                      </button>
                    ) : null}
                  </div>
                  <textarea
                    rows={2}
                    value={statement}
                    onChange={(e) => { setStatement(e.target.value); setDrafted(false); }}
                    placeholder={t('createLoopStatementPlaceholder')}
                    className={cn(
                      'w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40',
                      drafted ? 'border-primary/40' : 'border-border',
                    )}
                  />
                  {drafted ? (
                    <p className="flex items-start gap-1.5 rounded-lg border border-dashed border-border bg-muted/40 px-2 py-1.5 text-[10px] text-muted-foreground">
                      <span>✦</span>
                      <span>
                        <b className="text-foreground">{t('createLoopDraftNoteTitle')}</b> {t('createLoopDraftNoteBody')}{' '}
                        <button type="button" onClick={() => void handleDraft()} className="font-semibold text-primary hover:underline">
                          {t('createLoopDraftRetry')}
                        </button>
                      </span>
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('createLoopMetricLabel')} <span className="text-destructive">*</span>
                  </label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
                    <input
                      value={metric.metric}
                      onChange={(e) => setMetricPatch({ metric: e.target.value })}
                      placeholder={th('metricPlaceholder')}
                      className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <select
                      value={metric.source}
                      onChange={(e) => setMetricPatch({ source: e.target.value as MetricDefinition['source'] })}
                      className="rounded-xl border border-border bg-background px-2 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      {SOURCES.map((s) => (
                        <option key={s} value={s}>
                          {s === 'ga4' ? th('sourceGa4') : s === 'manual' ? th('sourceManual') : th('sourceInternal')}
                        </option>
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
                            metric.direction === dir ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {dir === 'up' ? th('dirUp') : th('dirDown')}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={Number.isNaN(metric.target) ? '' : metric.target}
                      onChange={(e) => setMetricPatch({ target: e.target.value === '' ? 0 : Number(e.target.value) })}
                      placeholder={th('targetPlaceholder')}
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 sm:w-20"
                    />
                  </div>

                  {isGa4 ? (
                    <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-border p-2 sm:grid-cols-3">
                      <input
                        value={metric.property_id ?? ''}
                        onChange={(e) => setMetricPatch({ property_id: e.target.value })}
                        placeholder={t('createLoopGa4PropertyIdPlaceholder')}
                        className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                      <select
                        value={metric.ga4_metric ?? ''}
                        onChange={(e) => setMetricPatch({ ga4_metric: e.target.value })}
                        className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                      >
                        <option value="">{t('createLoopGa4MetricPlaceholder')}</option>
                        {GA4_METRICS.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={metric.date_range_days ?? ''}
                        onChange={(e) => setMetricPatch({ date_range_days: e.target.value === '' ? undefined : Number(e.target.value) })}
                        placeholder={t('createLoopGa4DateRangePlaceholder')}
                        className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </div>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t('createLoopMeasureAfterLabel')} <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="date"
                    value={measureAfter}
                    onChange={(e) => setMeasureAfter(e.target.value)}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <input
                  value={hypothesisSearch}
                  onChange={(e) => setHypothesisSearch(e.target.value)}
                  placeholder={t('createLoopLinkSearchPlaceholder')}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                {hypotheses === null ? (
                  <p className="py-2 text-center text-xs text-muted-foreground">{t('loading')}</p>
                ) : filteredHypotheses.length === 0 ? (
                  <p className="py-2 text-center text-xs text-muted-foreground">{t('createLoopLinkEmpty')}</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {filteredHypotheses.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => setLinkedId(h.id)}
                        className={cn(
                          'w-full rounded-lg border px-2.5 py-1.5 text-left text-xs transition',
                          linkedId === h.id ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:border-primary/40',
                        )}
                      >
                        {h.statement}
                      </button>
                    ))}
                  </div>
                )}
                {linkedHypothesis ? (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-2 text-[11px] text-foreground">
                    <p className="font-medium">{linkedHypothesis.statement}</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {linkedHypothesis.metric_definition.metric} · {linkedHypothesis.status}
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('createLoopTagsLabel')}</label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('createLoopTagsPlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="items-center justify-between sm:justify-between">
          <span className={cn('text-[11px] font-medium', goalComplete ? 'text-success' : 'text-muted-foreground')}>
            {goalComplete ? t('createLoopGoalComplete') : t('createLoopValidationHint')}
          </span>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? t('createLoopSubmitting') : t('createLoopSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
