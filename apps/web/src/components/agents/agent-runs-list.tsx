'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Activity, ChevronDown, Clock3, Cpu, Hash, RotateCw, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { parseCursorMeta } from '@/lib/pagination';
import {
  ALL_RUN_STATUS_FILTER,
  DEFAULT_RUN_LOOKBACK_DAYS,
  DEFAULT_RUN_STATUS_FILTER,
  getDefaultRunDateFilters,
  getLocalDayEndIso,
  getLocalDayStartIso,
  getRunFailureDisposition,
  getTriggerMemoHref,
  normalizeRunStatusFilter,
} from '@/services/agent-run-history';
import { AgentRunDetail } from './agent-run-detail';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  AGENT_RUN_STATUS_ORDER,
  agentRunStatusBadgeVariant,
  type AgentRunStatus,
} from '@/lib/agent-run-status';

import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';

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
  status: AgentRunStatus;
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

const STATUS_FILTERS = [ALL_RUN_STATUS_FILTER, ...AGENT_RUN_STATUS_ORDER] as const;

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

// story #3493 — run.created_at은 "기록" — 3436 묶음 8 정본(formatRelativeTime)으로.
function toLocaleDateStr(iso: string, locale: string, displayTimezone: string): string {
  return formatRelativeTime(iso, locale, displayTimezone);
}

function formatBillingMode(t: ReturnType<typeof useTranslations>, billingMode: AgentRun['llm_provider']): string {
  if (!billingMode) return '-';
  return t(`billingMode_${billingMode}`);
}

export function AgentRunsList() {
  const t = useTranslations('agentRuns');
  const tc = useTranslations('common');
  // story #3680(그라운딩 2026-09-07) — 이 컴포넌트가 project_id를 «전혀» 안 보내고
  // 있었다(git log 전체에 이 필드가 있었던 적이 없음). BE list_agent_runs는
  // project_id를 Query(...) 필수로 요구해 매 요청이 422였고, 아래 fetchRuns의 옛
  // `if (!res.ok) return 빈 목록` 처리가 그 422를 조용히 「0행」으로 삼켰다 — 날짜
  // 범위와 무관하게 항상 0행이었던 진짜 근본원인.
  const { projectId } = useDashboardContext();

  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState(DEFAULT_RUN_STATUS_FILTER);
  const [{ fromDate: initialFromDate, toDate: initialToDate }] = useState(() => getDefaultRunDateFilters());
  const [fromDate, setFromDate] = useState(initialFromDate);
  const [toDate, setToDate] = useState(initialToDate);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  const fetchRuns = useCallback(async (cursor?: string) => {
    if (!projectId) throw new Error('projectId not ready');
    const params = new URLSearchParams();
    params.set('project_id', projectId);
    // story #3680 — 'all'은 서버 필터 값이 아니라 "필터 안 함"의 FE 표현(normalizeRunStatusFilter
    // 기존 헬퍼가 이미 그 변환을 하고 있었는데 이 호출부가 안 쓰고 있었다 — raw statusFilter를
    // 그대로 보내면 status=all이 나가 새로 추가된 BE Literal 검증에 422로 걸린다).
    const normalizedStatus = normalizeRunStatusFilter(statusFilter);
    if (normalizedStatus) params.set('status', normalizedStatus);
    if (fromDate) params.set('from', getLocalDayStartIso(fromDate));
    if (toDate) params.set('to', getLocalDayEndIso(toDate));
    if (cursor) params.set('cursor', cursor);

    const res = await fetchWithAuth(`/api/v1/agent-runs?${params}`);
    // story #3680(페드루 PO 지시) — 「실패」와 「0건」은 다른 얼굴이어야 한다. 옛 코드는
    // non-ok를 조용히 빈 목록으로 접어 project_id 누락 422를 "실행 없음"으로 위장시켰다
    // (진짜 근본원인이었다). 여기서 throw해 아래 useEffect의 기존 loadError 경로로
    // 넘긴다(신규 상태 0 — try/catch/loadError는 이미 있었다).
    if (!res.ok) throw new Error(`agent-runs fetch failed: ${res.status}`);
    const json = await res.json();
    // story #2231 AC4: 이 프록시는 apiSuccess(await _r.json())로 BE의 {data,meta} 전체를
    // 다시 자기 data 필드에 얹는다(comments가 #2230 전에 그랬던 것과 동형 이중포장) — 바깥
    // meta는 항상 null이라 「더 보기」가 지금 구조적으로 죽어 있다. 공용 파서로 그 사실을
    // 조용히 삼키지 않고 드러낸다(프록시 자체 fix는 #2231 AC2 스코프, 별도 처리).
    return {
      items: (json.data ?? []) as AgentRun[],
      nextCursor: parseCursorMeta(json.meta, 'agent-runs-list').nextCursor,
    };
  }, [projectId, statusFilter, fromDate, toDate]);

  // story #2000: 원 raw fetch가 네트워크 단에서 throw하면(오프라인 등) try 없이 setLoading(false)가
  // 영영 안 불려 스켈레톤이 무한행 — try/catch/finally + loadError/retryKey로 봉합(D #1989 패턴).
  // story #3680 — projectId가 아직 없으면(대시보드 컨텍스트 로드 중) 요청 자체를 미루고
  // 로딩 상태를 유지한다(빈 목록도 에러도 아니다 — "아직 모른다").
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      setSelectedRunId(null);
      try {
        const result = await fetchRuns();
        if (cancelled) return;
        setRuns(result.items);
        setNextCursor(result.nextCursor);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, fetchRuns, retryKey]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const result = await fetchRuns(nextCursor);
      setRuns((prev) => [...prev, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch {
      // 더보기 실패는 조용히 두고 버튼을 그대로 남겨(재클릭으로 재시도 가능) — 이미 로드된
      // runs 목록은 유지, 별도 에러 UI 없이도 재시도 affordance가 버튼 자체로 성립.
    } finally {
      setLoadingMore(false);
    }
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
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filters */}
        <div className="flex-shrink-0 border-b border-border/80 px-6 py-3">
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
        </div>
        {/* Runs list */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm font-medium text-foreground">{tc('error')}</p>
              <p className="text-xs text-muted-foreground">{tc('errorDescription')}</p>
              <Button variant="glass" size="sm" onClick={() => setRetryKey((k) => k + 1)}>
                <RotateCw className="mr-1.5 size-3.5" />
                {tc('retry')}
              </Button>
            </div>
          ) : runs.length === 0 ? (
            // story #3680 AC3 — 기본 창(넓히지 않은 상태)의 0건은 "실행 없음"과 다른
            // 사실이다("창 밖일 수 있다") — 날짜를 한 번이라도 건드렸으면 일반 문구로.
            fromDate === initialFromDate && toDate === initialToDate ? (
              <EmptyState
                title={t('emptyTitleDefaultWindow', { days: DEFAULT_RUN_LOOKBACK_DAYS })}
                description={t('emptyDescriptionDefaultWindow', { days: DEFAULT_RUN_LOOKBACK_DAYS })}
              />
            ) : (
              <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
            )
          ) : (
            <div className="space-y-3">
              {runs.map((run, index) => (
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
                        <Badge variant={agentRunStatusBadgeVariant(run.status)}>
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
                        <span>{toLocaleDateStr(run.created_at, locale, displayTimezone)}</span>
                      </div>
                      {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「상세 보기」
                          접근 이름이라 보조기술 버튼 목록에서 어느 실행 행인지 못
                          가른다. */}
                      <Button
                        variant="glass" size="sm" onClick={() => setSelectedRunId(run.id)}
                        aria-label={t('openDetailAriaLabel', { n: index + 1, label: t('openDetail') })}
                      >
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
        </div>
      </div>
    </>
  );
}
