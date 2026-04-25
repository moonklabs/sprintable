'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Activity, ArrowLeft, ChevronDown, Clock3, Cpu, Hash, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import {
  ALL_RUN_STATUS_FILTER,
  DEFAULT_RUN_STATUS_FILTER,
  getDefaultRunDateFilters,
  getLocalDayEndIso,
  getLocalDayStartIso,
  getRunFailureDisposition,
  getTriggerMemoHref,
} from '@/services/agent-run-history';
import { AgentRunDetail } from './agent-run-detail';

interface AgentRun {
  id: string;
  agent_id: string;
  agent_name: string | null;
  deployment_id: string | null;
  session_id: string | null;
  memo_id: string | null;
  story_id: string | null;
  trigger: string;
  model: string | null;
  llm_provider: 'managed' | 'byom' | null;
  llm_provider_key: string | null;
  status: 'queued' | 'held' | 'running' | 'hitl_pending' | 'completed' | 'failed';
  duration_ms: number | null;
  llm_call_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  computed_cost_cents: number;
  per_run_cap_cents: number | null;
  billing_notes: string[];
  result_summary: string | null;
  error_message: string | null;
  last_error_code: string | null;
  retry_count: number | null;
  max_retries: number | null;
  next_retry_at: string | null;
  failure_disposition: 'retry_scheduled' | 'retry_launched' | 'retry_exhausted' | 'non_retryable' | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

const STATUS_FILTERS = [ALL_RUN_STATUS_FILTER, 'completed', 'hitl_pending', 'failed', 'running', 'queued', 'held'] as const;

const STATUS_BADGE_VARIANT: Record<string, 'success' | 'destructive' | 'info' | 'outline' | 'secondary'> = {
  completed: 'success',
  hitl_pending: 'secondary',
  failed: 'destructive',
  running: 'info',
  queued: 'outline',
  held: 'secondary',
};

function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatTokens(n: number | null): string {
  if (n == null) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number | null): string {
  if (usd == null) return '-';
  return `$${usd.toFixed(4)}`;
}

function toLocaleDateStr(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBillingMode(t: ReturnType<typeof useTranslations>, billingMode: AgentRun['llm_provider']): string {
  if (!billingMode) return '-';
  return t(`billingMode_${billingMode}`);
}

export function AgentRunsList() {
  const t = useTranslations('agentRuns');
  const tc = useTranslations('common');

  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState(DEFAULT_RUN_STATUS_FILTER);
  const [{ fromDate: initialFromDate, toDate: initialToDate }] = useState(() => getDefaultRunDateFilters());
  const [fromDate, setFromDate] = useState(initialFromDate);
  const [toDate, setToDate] = useState(initialToDate);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [locale] = useState(() =>
    typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en',
  );

  const fetchRuns = useCallback(async (cursor?: string) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (fromDate) params.set('from', getLocalDayStartIso(fromDate));
    if (toDate) params.set('to', getLocalDayEndIso(toDate));
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`/api/v1/agent-runs?${params}`);
    if (!res.ok) return { items: [], nextCursor: null };
    const json = await res.json();
    return {
      items: (json.data ?? []) as AgentRun[],
      nextCursor: json.meta?.nextCursor ?? null,
    };
  }, [statusFilter, fromDate, toDate]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setSelectedRunId(null);
      const result = await fetchRuns();
      if (cancelled) return;
      setRuns(result.items);
      setNextCursor(result.nextCursor);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [fetchRuns]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const result = await fetchRuns(nextCursor);
    setRuns((prev) => [...prev, ...result.items]);
    setNextCursor(result.nextCursor);
    setLoadingMore(false);
  };

  if (selectedRunId) {
    return (
      <AgentRunDetail
        runId={selectedRunId}
        locale={locale}
        onBack={() => setSelectedRunId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />

      <SectionCard>
        <SectionCardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex flex-wrap items-center gap-2">
              {STATUS_FILTERS.map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? 'hero' : 'glass'}
                  size="sm"
                  onClick={() => setStatusFilter(s)}
                >
                  {s === ALL_RUN_STATUS_FILTER ? t('filterAll') : t(`status_${s}`)}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2 sm:ml-auto">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none"
                aria-label={t('fromDate')}
              />
              <span className="text-xs text-muted-foreground">~</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none"
                aria-label={t('toDate')}
              />
            </div>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
          ) : (
            <div className="space-y-3">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="rounded-md border border-border bg-muted/30 px-4 py-4 transition hover:border-primary/20 hover:bg-muted"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">
                          {run.agent_name ?? t('unknownAgent')}
                        </h3>
                        <Badge variant={STATUS_BADGE_VARIANT[run.status] ?? 'outline'}>
                          {t(`status_${run.status}`)}
                        </Badge>
                        {run.model && <Badge variant="chip">{run.model}</Badge>}
                        {run.llm_provider_key && <Badge variant="chip">{run.llm_provider_key}</Badge>}
                        {run.llm_provider && <Badge variant="chip">{formatBillingMode(t, run.llm_provider)}</Badge>}
                        {run.status === 'failed' && getRunFailureDisposition(run) && (
                          <Badge variant={getRunFailureDisposition(run) === 'retry_scheduled' ? 'info' : 'outline'}>
                            {t(`failureDisposition_${getRunFailureDisposition(run)}`)}
                          </Badge>
                        )}
                        {run.memo_id && (
                          <Link
                            href={getTriggerMemoHref(run.memo_id)}
                            className="inline-flex items-center rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:border-primary/25 hover:text-primary"
                          >
                            {t('openMemo')}
                          </Link>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock3 className="size-3.5" />
                          {formatDuration(run.duration_ms)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Cpu className="size-3.5" />
                          {run.llm_call_count} {t('llmCalls')}
                        </span>
                        <span className="flex items-center gap-1">
                          <Hash className="size-3.5" />
                          {formatTokens(run.input_tokens)}/{formatTokens(run.output_tokens)} tok
                        </span>
                        <span className="flex items-center gap-1">
                          <Zap className="size-3.5" />
                          {formatCost(run.cost_usd)}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col items-start gap-3 lg:items-end">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Activity className="size-3.5" />
                        <span>{toLocaleDateStr(run.created_at, locale)}</span>
                      </div>
                      <Button variant="glass" size="sm" onClick={() => setSelectedRunId(run.id)}>
                        {t('openDetail')}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}

              {nextCursor && (
                <div className="pt-2 text-center">
                  <Button variant="glass" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? tc('loading') : (
                      <>
                        <ChevronDown className="mr-1 size-4" />
                        {t('loadMore')}
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
