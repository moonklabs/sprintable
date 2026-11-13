'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { Chip, type ChipProps } from '@/components/ds/chip';
import { Input } from '@/components/ds/input';
import { LAYER } from '@/components/ds/layers';
import { ListRow } from '@/components/ds/list-row';
import { ContextMenu, ContextMenuTrigger, MenuContent, MenuItem } from '@/components/ds/menu';
import { NativeSelect } from '@/components/ds/select';
import { SectionHeader } from '@/components/ds/section-header';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { AgentRunsTopBarTitle } from '@/components/nav/flat-tab-top-bar';
import { handleListKeys } from '@/lib/list-keys';
import { parseCursorMeta } from '@/lib/pagination';
import {
  ALL_RUN_STATUS_FILTER,
  DEFAULT_RUN_LOOKBACK_DAYS,
  getDefaultRunDateFilters,
  getDayEndIso,
  getDayStartIso,
  getRunErrorDisplay,
  getRunFailureDisposition,
  getTriggerMemoHref,
  normalizeRunStatusFilter,
} from '@/services/agent-run-history';
import { AgentRunDetail } from './agent-run-detail';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { AGENT_RUN_STATUS_ORDER, agentRunStatusBadgeVariant, type AgentRunStatus, type AgentRunStatusBadgeVariant } from '@/lib/agent-run-status';

/** 4911 — the run groups are the content layer over the page; a run row is the «others» row face on that layer (pinned by `styles/layer-rule.test.ts`) */
export const AGENT_RUNS_PANEL_FACE = LAYER.panel;
export const AGENT_RUNS_ROW_FACE = LAYER.rowOthers;

import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

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

type Fetched = { items: AgentRun[]; nextCursor: string | null };

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

/**
 * story 4911 — the status chip's tone. The status → face fact is said ONCE, in the catalog (`lib/agent-run-status.ts`, story 3689); this screen only translates the catalog's badge variant into the ds Chip's tone
 * (the Chip has no «warning»: an unfinished (`abandoned`) run is one a person should look at → `needs-hand`; the word is always written, so the colour never speaks alone).
 * Only a MEANING gets a colour (failed · waiting on a person · done · live); `queued` / `held` and the unknown stay neutral. A person-wait (`hitl_pending`) is `needs-hand` whatever the catalog's shared variant says.
 */
const VARIANT_TONE: Record<AgentRunStatusBadgeVariant, NonNullable<ChipProps['tone']>> = {
  success: 'done',
  destructive: 'failed',
  info: 'info',
  outline: 'neutral',
  secondary: 'neutral',
  warning: 'needs-hand',
};
const statusTone = (status: AgentRunStatus): NonNullable<ChipProps['tone']> =>
  status === 'hitl_pending' ? 'needs-hand' : VARIANT_TONE[agentRunStatusBadgeVariant(status)];

const ATTENTION_STATUSES: AgentRunStatus[] = ['failed', 'hitl_pending'];
const PROGRESS_STATUSES: AgentRunStatus[] = ['running', 'queued', 'held'];
const byNewest = (a: AgentRun, b: AgentRun) => Date.parse(b.created_at) - Date.parse(a.created_at);

/**
 * story 4911 — the groups of the «all» view: «먼저 볼 것» (failed + waiting on a person, from their own list calls so a long list of finished runs can never push them off the first page),
 * «진행 중», «끝난 것». The same three `/agent-runs` calls the screen always made (no backend change). A failed call of the two small lists falls back to what the main list already holds.
 */
export function groupRuns(all: AgentRun[], failed: AgentRun[] | null, hitl: AgentRun[] | null) {
  const seen = new Set<string>();
  const attention: AgentRun[] = [];
  // the two dedicated lists first (they reach past the main list's first page); then EVERY failed / waiting run the main list holds — a later page of «더 보기» carries older ones the dedicated first pages do not,
  // and a run must never fall out of the «all» view (codex 01a1d535: they were filtered out of «끝난 것» and listed nowhere). A failed dedicated call (null) is covered by this last part alone.
  for (const r of [...(failed ?? []), ...(hitl ?? []), ...all.filter((x) => ATTENTION_STATUSES.includes(x.status))]) {
    if (!seen.has(r.id)) { seen.add(r.id); attention.push(r); }
  }
  attention.sort(byNewest);
  const rest = all.filter((r) => !seen.has(r.id) && !ATTENTION_STATUSES.includes(r.status));
  return {
    attention,
    progress: rest.filter((r) => PROGRESS_STATUSES.includes(r.status)),
    done: rest.filter((r) => !PROGRESS_STATUSES.includes(r.status)),
  };
}

function RunRow({ run, active, onOpen, onActive }: { run: AgentRun; active: boolean; onOpen: (id: string) => void; onActive: (id: string) => void }) {
  const t = useTranslations('agentRuns');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone();
  const disposition = run.status === 'failed' ? getRunFailureDisposition(run) : null;
  // the one line that says WHAT it is: what went wrong (failed) · what is waited for (waiting on a person) · the result (the rest)
  const what = run.status === 'failed'
    ? (getRunErrorDisplay(run.error_message, run.last_error_code).message ?? run.result_summary)
    : run.status === 'hitl_pending' ? (run.result_summary ?? t('hitlWaiting')) : run.result_summary;
  const billing = run.llm_provider ? t(`billingMode_${run.llm_provider}`) : null;
  const meta = [
    run.model, run.llm_provider_key, billing,
    `${run.llm_call_count} ${t('llmCalls')}`, `${formatTokens(run.input_tokens)}/${formatTokens(run.output_tokens)} tok`,
    formatDuration(run.duration_ms), formatCost(run.cost_usd), formatViewerRelativeTime(run.created_at, locale, displayTimezone),
  ].filter(Boolean).join(' · ');
  const memoHref = run.memo_id ? getTriggerMemoHref(run.memo_id) : null;
  // the accessible name tells two runs of the same agent apart by when each started (to the second, in the viewer's zone) — «story #3592: the same open name on every row cannot tell the rows apart»
  const startedAt = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone: displayTimezone ?? undefined }).format(new Date(run.created_at));
  // a run waiting on a person gets the row's «needs your hand» bar + its hidden name (the bar never carries the meaning by colour alone)
  const needs = run.status === 'hitl_pending'
    ? { needsHand: true as const, needsHandLabel: t('status_hitl_pending') }
    : { needsHand: false as const };
  const rowEl = (
    <ListRow
      density="default"
      selected={active}
      {...needs}
      className={`${AGENT_RUNS_ROW_FACE} rounded-ds-control border ${run.status === 'failed' ? 'before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-ds-control before:bg-ds-failed' : ''} has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset has-[button:focus-visible]:ring-ds-action`}
      leading={<Chip tone={statusTone(run.status)} dot>{t(`status_${run.status}`)}</Chip>}
      title={(
        // the title is a real button: Tab reaches it, Enter opens the run (a click anywhere on the row does the same)
        <Button
          type="button"
          variant="quiet"
          data-row-focus
          className="h-auto max-w-full justify-start px-0 text-left text-ds-body font-semibold text-ds-ink hover:bg-transparent hover:text-ds-ink"
          // story #3592 — the same «open» name on every row cannot tell the rows apart to assistive technology: the agent name · the status · the start time say which run
          aria-label={`${run.agent_name ?? t('unknownAgent')} · ${t(`status_${run.status}`)} · ${startedAt} · ${t('openDetail')}`}
        >
          <span className="truncate">
            {run.agent_name ?? t('unknownAgent')}
            {what ? <span className="font-normal text-ds-ink-2"> · {what}</span> : null}
          </span>
        </Button>
      )}
      subtitle={meta}
      trailing={(
        <>
          {disposition ? <Chip tone={disposition === 'retry_scheduled' ? 'info' : 'neutral'}>{t(`failureDisposition_${disposition}`)}</Chip> : null}
          {memoHref ? (
            <Link
              href={memoHref}
              data-memo-link
              onClick={(e) => e.stopPropagation()}
              className="inline-flex h-ds-compact items-center rounded-ds-control border border-ds-line-control px-2 text-ds-small font-medium text-ds-ink hover:bg-ds-surface-high touch:min-h-ds-touch"
            >
              {t('openMemo')}
            </Link>
          ) : null}
        </>
      )}
    />
  );
  const rowProps = { 'data-row-key': run.id, 'data-testid': 'agent-run-row', onClick: () => onOpen(run.id), onFocus: () => onActive(run.id) };
  return (
    // the right-click menu (the Mac app and the web alike): ONLY actions the row already has — open the run · open its trigger memo; never a right-click-only action (the row opens by click · Enter, the memo by its link)
    <ContextMenu>
      <ContextMenuTrigger render={<div {...rowProps} />}>{rowEl}</ContextMenuTrigger>
      <MenuContent align="start">
        <MenuItem onClick={() => onOpen(run.id)}>{t('menuOpen')}</MenuItem>
        {memoHref ? <MenuItem render={<Link href={memoHref} />}>{t('menuOpenMemo')}</MenuItem> : null}
      </MenuContent>
    </ContextMenu>
  );
}

function RunSection({ title, runs, activeKey, onOpen, onActive, error, onRetry, children }: {
  title: string; runs: AgentRun[]; activeKey: string | null; onOpen: (id: string) => void; onActive: (id: string) => void; error?: boolean; onRetry?: () => void; children?: React.ReactNode;
}) {
  const t = useTranslations('agentRuns');
  const tc = useTranslations('common');
  if (runs.length === 0 && !error && !children) return null;
  return (
    <section data-testid="agent-runs-section" className={`${AGENT_RUNS_PANEL_FACE} space-y-1 rounded-ds-panel border border-ds-line p-2`}>
      <SectionHeader title={title} count={<span className="text-ds-mono-md text-ds-ink-3">{runs.length}</span>} level={2} />
      {error ? (
        <div role="alert" className="flex items-center gap-3 px-2 py-2 text-ds-small text-ds-ink-2">
          <span>{t('sectionLoadError')}</span>
          {onRetry ? <Button type="button" variant="quiet" onClick={onRetry}><RotateCw className="mr-1.5 size-3.5" />{tc('retry')}</Button> : null}
        </div>
      ) : null}
      {runs.map((run) => <RunRow key={run.id} run={run} active={activeKey === run.id} onOpen={onOpen} onActive={onActive} />)}
      {children}
    </section>
  );
}

export function AgentRunsList() {
  const t = useTranslations('agentRuns');
  const tc = useTranslations('common');
  // story #3680(그라운딩 2026-09-07) — 이 컴포넌트가 project_id를 «전혀» 안 보내고 있었다. BE list_agent_runs는 project_id를 Query(...) 필수로 요구해 매 요청이 422였고, 옛 non-ok 처리가
  // 그 422를 조용히 「0행」으로 삼켰다 — 날짜 범위와 무관하게 항상 0행이었던 진짜 근본원인.
  const { projectId } = useDashboardContext();

  const [data, setData] = useState<{ all: Fetched; failed: Fetched | null; hitl: Fetched | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  // story 4911 (PO Q1): the default is «전체» with the things to look at on top — the old default («완료») hid the failed runs behind a filter tap
  const [statusFilter, setStatusFilter] = useState<string>(ALL_RUN_STATUS_FILTER);
  // story #4443 PR3a — the default days are the viewer's (derived until the person picks: no zone yet → empty, then filled)
  const viewerTz = useViewerTimeZone();
  const defaults = getDefaultRunDateFilters(viewerTz);
  const [pickedFrom, setFromDate] = useState<string | null>(null);
  const [pickedTo, setToDate] = useState<string | null>(null);
  const fromDate = pickedFrom ?? defaults.fromDate;
  const toDate = pickedTo ?? defaults.toDate;
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const locale = useLocale();

  const fetchRuns = useCallback(async (status: string | null, cursor?: string): Promise<Fetched> => {
    if (!projectId) throw new Error('projectId not ready');
    const params = new URLSearchParams();
    params.set('project_id', projectId);
    // story #3680 — 'all'은 서버 필터 값이 아니라 "필터 안 함"의 FE 표현(normalizeRunStatusFilter) — raw 'all'을 보내면 status=all이 BE Literal 422에 걸린다.
    const normalizedStatus = status === null ? null : normalizeRunStatusFilter(status);
    if (normalizedStatus) params.set('status', normalizedStatus);
    if (fromDate && viewerTz) params.set('from', getDayStartIso(fromDate, viewerTz));
    if (toDate && viewerTz) params.set('to', getDayEndIso(toDate, viewerTz));
    if (cursor) params.set('cursor', cursor);
    const res = await fetchWithAuth(`/api/v1/agent-runs?${params}`);
    // story #3680(페드루 PO 지시) — 「실패」와 「0건」은 다른 얼굴이어야 한다: non-ok는 throw해 에러 상태로(조용히 빈 목록으로 접지 않는다).
    if (!res.ok) throw new Error(`agent-runs fetch failed: ${res.status}`);
    const json = await res.json();
    // story #2231 AC4: 이 프록시는 BE의 {data,meta} 전체를 다시 자기 data 필드에 얹는다 — 바깥 meta는 항상 null이라 「더 보기」가 지금 구조적으로 죽어 있다(프록시 자체 fix는 #2231 AC2 스코프).
    return { items: (json.data ?? []) as AgentRun[], nextCursor: parseCursorMeta(json.meta, 'agent-runs-list').nextCursor };
  }, [projectId, fromDate, toDate, viewerTz]); // story #4443 PR3a — the day bounds are the viewer's zone

  // story #2000: 네트워크 throw(오프라인 등)에서도 스켈레톤이 영원히 안 남게 try/catch/finally + loadError/retryKey. story #3680 — projectId가 아직 없으면 요청 자체를 미룬다("아직 모른다").
  // story 4911: the «all» view makes three calls at once (all · failed · waiting on a person — measured on dev: 633 ms for the three together, one call alone ≈ 630 ms). The main list failing = the list is unreadable (the error
  // face, as before); one of the two small calls failing only costs ITS part: the main list already holds those runs (see groupRuns), so nothing is hidden and nothing is faked.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      setSelectedRunId(null);
      try {
        if (statusFilter === ALL_RUN_STATUS_FILTER) {
          const [all, failed, hitl] = await Promise.allSettled([fetchRuns(null), fetchRuns('failed'), fetchRuns('hitl_pending')]);
          if (cancelled) return;
          if (all.status === 'rejected') throw all.reason;
          setData({ all: all.value, failed: failed.status === 'fulfilled' ? failed.value : null, hitl: hitl.status === 'fulfilled' ? hitl.value : null });
        } else {
          const one = await fetchRuns(statusFilter);
          if (cancelled) return;
          setData({ all: one, failed: null, hitl: null });
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, fetchRuns, statusFilter, retryKey]);

  const loadMore = async () => {
    if (!data?.all.nextCursor) return;
    setLoadingMore(true);
    try {
      const result = await fetchRuns(statusFilter === ALL_RUN_STATUS_FILTER ? null : statusFilter, data.all.nextCursor);
      setData((prev) => (prev ? { ...prev, all: { items: [...prev.all.items, ...result.items], nextCursor: result.nextCursor } } : prev));
    } catch {
      // 더보기 실패는 조용히 두고 버튼을 그대로 남겨(재클릭으로 재시도) — 이미 로드된 목록은 유지.
    } finally {
      setLoadingMore(false);
    }
  };

  // Esc in a run's detail goes back to the list (the same «back» the detail's own button does)
  useEffect(() => {
    if (!selectedRunId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      setSelectedRunId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedRunId]);

  const grouped = useMemo(() => (data && statusFilter === ALL_RUN_STATUS_FILTER ? groupRuns(data.all.items, data.failed?.items ?? null, data.hitl?.items ?? null) : null), [data, statusFilter]);
  const isDefaultWindow = fromDate === defaults.fromDate && toDate === defaults.toDate;
  const total = data ? (grouped ? grouped.attention.length + grouped.progress.length + grouped.done.length : data.all.items.length) : 0;

  if (selectedRunId) {
    return (
      <AgentRunDetail
        runId={selectedRunId}
        locale={locale}
        onBack={() => setSelectedRunId(null)}
      />
    );
  }

  const onListKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    handleListKeys(e, setActiveKey);
    // M — the trigger memo of the focused run (a click on its «메모 열기» link; nothing new: the link is on the row)
    if (e.key === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) {
      (e.target as HTMLElement).closest<HTMLElement>('[data-row-key]')?.querySelector<HTMLAnchorElement>('a[data-memo-link]')?.click();
    }
  };
  const statusOptions = [ALL_RUN_STATUS_FILTER, ...AGENT_RUN_STATUS_ORDER] as const;

  return (
    <>
      <TopBarSlot title={<AgentRunsTopBarTitle />} showContextChip />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filters — one line: the status (the same values as before) and the period (the same two dates) */}
        <div className="flex-shrink-0 border-b border-ds-line px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              className="w-44"
              aria-label={t('statusFilterLabel')}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>{s === ALL_RUN_STATUS_FILTER ? t('filterAll') : t(`status_${s}`)}</option>
              ))}
            </NativeSelect>
            <div className="flex items-center gap-2 sm:ml-auto">
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="min-w-0 flex-1 px-2 sm:w-auto sm:flex-none sm:px-3" aria-label={t('fromDate')} />
              <span className="text-xs text-ds-ink-3">~</span>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="min-w-0 flex-1 px-2 sm:w-auto sm:flex-none sm:px-3" aria-label={t('toDate')} />
            </div>
          </div>
        </div>
        {/* Runs list */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3" onKeyDown={onListKeyDown}>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-ds-control bg-ds-surface-high" />
              ))}
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm font-medium text-ds-ink">{tc('error')}</p>
              <p className="text-xs text-ds-ink-3">{tc('errorDescription')}</p>
              <Button variant="secondary" onClick={() => setRetryKey((k) => k + 1)}>
                <RotateCw className="mr-1.5 size-3.5" />
                {tc('retry')}
              </Button>
            </div>
          ) : total === 0 && data && !(grouped && (data.failed === null || data.hitl === null)) ? (
            // story #3680 AC3 — 기본 창(넓히지 않은 상태)의 0건은 "실행 없음"과 다른 사실이다("창 밖일 수 있다") — 날짜를 한 번이라도 건드렸으면 일반 문구로.
            isDefaultWindow ? (
              <EmptyState
                title={t('emptyTitleDefaultWindow', { days: DEFAULT_RUN_LOOKBACK_DAYS })}
                description={t('emptyDescriptionDefaultWindow', { days: DEFAULT_RUN_LOOKBACK_DAYS })}
              />
            ) : (
              <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
            )
          ) : data ? (
            <div className="space-y-3">
              {grouped ? (
                <>
                  <RunSection title={t('sectionAttention')} runs={grouped.attention} activeKey={activeKey} onOpen={setSelectedRunId} onActive={setActiveKey}
                    error={data.failed === null || data.hitl === null} onRetry={() => setRetryKey((k) => k + 1)} />
                  <RunSection title={t('sectionProgress')} runs={grouped.progress} activeKey={activeKey} onOpen={setSelectedRunId} onActive={setActiveKey} />
                  <RunSection title={t('sectionDone')} runs={grouped.done} activeKey={activeKey} onOpen={setSelectedRunId} onActive={setActiveKey}>
                    {data.all.nextCursor ? (
                      <div className="pt-1 text-center">
                        <Button variant="quiet" onClick={loadMore} disabled={loadingMore}>
                          {loadingMore ? tc('loading') : t('loadMore')}
                        </Button>
                      </div>
                    ) : null}
                  </RunSection>
                </>
              ) : (
                // a status picked → one flat list (the filter and the groups are not two ways to the same thing)
                <RunSection title={t(`status_${statusFilter as AgentRunStatus}`)} runs={data.all.items} activeKey={activeKey} onOpen={setSelectedRunId} onActive={setActiveKey}>
                  {data.all.nextCursor ? (
                    <div className="pt-1 text-center">
                      <Button variant="quiet" onClick={loadMore} disabled={loadingMore}>
                        {loadingMore ? tc('loading') : t('loadMore')}
                      </Button>
                    </div>
                  ) : null}
                </RunSection>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
