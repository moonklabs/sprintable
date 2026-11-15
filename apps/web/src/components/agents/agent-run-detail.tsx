'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { LAYER } from '@/components/ds/layers';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { getRunErrorDisplay, getRunFailureDisposition } from '@/services/agent-run-history';
import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { formatViewerScheduledAt } from '@/lib/schedule-format';
import type { AgentRunStatus } from '@/lib/agent-run-status';
import { statusTone } from './agent-run-status-tone';
import { AgentRunToolCallsSection } from './agent-run-tool-calls-section';
import { AGENT_RUNS_BODY_FRAME } from './agent-runs-frame';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

interface RunDetail {
  id: string;
  agent_id: string;
  agent_name: string | null;
  deployment_id: string | null;
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

// story #3722(Trust·PR2) — agent-run-tool-calls-section.tsx가 같은 포맷 규칙을 재사용(초 단위
// duration_ms 표시). export해 중복 정의를 피한다.
export function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

// story #3493 — started_at/finished_at/entry.created_at은 "기록"(정본 formatRelativeTime).
export function toLocaleStr(iso: string | null, locale: string, displayTimezone: string | null): string {
  if (!iso) return '-';
  return formatViewerRelativeTime(iso, locale, displayTimezone);
}

function formatBillingModeLabel(t: ReturnType<typeof useTranslations>, billingMode: RunDetail['llm_provider']): string {
  if (!billingMode) return '-';
  return t(`billingMode_${billingMode}`);
}

/** 4911 — the detail's faces: the content panel is the content layer over the page; the number strip is the «others» row face on that panel (pinned by `styles/layer-rule.test.ts`) */
export const AGENT_RUN_DETAIL_PANEL_FACE = LAYER.panel;
export const AGENT_RUN_DETAIL_STRIP_FACE = LAYER.rowOthers;

export function AgentRunDetail({
  runId,
  locale,
  onBack,
}: {
  runId: string;
  locale: string;
  onBack: () => void;
}) {
  const t = useTranslations('agentRuns');
  const tc = useTranslations('common');
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // story #1989: fetch 자체에 try/catch가 없어 네트워크 실패(오프라인 등) 시 fetch가 throw →
  // setLoading(false)가 영영 안 불려 스켈레톤이 무한 행("loading은 finally에서 해소" 하우스룰
  // 위반). loadError로 실패를 별도 상태화해 재시도 affordance를 노출한다.
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
      setRun(null);   // a new run id (or a retry) must not show the PREVIOUS run's name · id in the title and the head while it loads
      try {
        const res = await fetchWithAuth(`/api/v1/agent-runs/${runId}`);
        const json = res.ok ? await res.json() : null;
        if (cancelled) return;
        setRun(json?.data ?? null);
        if (!res.ok) setLoadError(true);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [runId, retryKey]);

  // the top bar's title is this page's h1 (story #3945/#3946: a detail screen with no other h1) — in EVERY state, so the title and the «목록으로» head never vanish behind a skeleton or an error
  // (one element per agent name: a new element every render would make the slot tear down and register again every render)
  const loadedAgentName = run ? (run.agent_name ?? t('unknownAgent')) : null;
  const titleEl = useMemo(
    () => <h1 className="truncate text-sm font-medium">{loadedAgentName !== null ? `${t('detailEyebrow')} · ${loadedAgentName}` : t('detailEyebrow')}</h1>,
    [loadedAgentName, t],
  );
  const slot = <TopBarSlot title={titleEl} />;
  const head = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="quiet" onClick={onBack} data-testid="run-detail-back">
        <ArrowLeft className="mr-1.5 size-4" aria-hidden="true" />
        {t('backToList')}
      </Button>
      {run ? <span className="text-ds-small text-ds-ink-3">{t('runId')}: {run.id.slice(0, 8)}…</span> : null}
    </div>
  );

  if (loading) {
    return (
      <div className={`space-y-3 ${AGENT_RUNS_BODY_FRAME}`}>
        {slot}
        {head}
        <div className="h-48 animate-pulse rounded-ds-panel bg-ds-surface-high" />
      </div>
    );
  }

  if (loadError) {
    return (
      // story #2105 2차 — load()가 재시도 전 setLoadError(false)를 먼저 호출해(위 정의) 매
      // retryKey 변경마다 언마운트→리마운트된다.
      <div className={`space-y-3 ${AGENT_RUNS_BODY_FRAME}`}>
        {slot}
        {head}
        <div role="alert" aria-live="assertive" aria-atomic="true" className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="text-ds-body font-medium text-ds-ink">{tc('error')}</p>
          <p className="text-ds-small text-ds-ink-3">{tc('errorDescription')}</p>
          <Button variant="secondary" onClick={() => setRetryKey((k) => k + 1)}>
            {tc('retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className={`space-y-3 ${AGENT_RUNS_BODY_FRAME}`}>
        {slot}
        {head}
        <div className="py-12 text-center text-ds-body text-ds-ink-3">{tc('noData')}</div>
      </div>
    );
  }

  const errorDisplay = getRunErrorDisplay(run.error_message, run.last_error_code);
  const failureDisposition = getRunFailureDisposition(run);
  const stats: Array<[string, string]> = [
    [t('duration'), formatDuration(run.duration_ms)],
    [t('llmCallsLabel'), String(run.llm_call_count)],
    [t('tokens'), `${run.input_tokens ?? 0} / ${run.output_tokens ?? 0}`],
    [t('cost'), run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '-'],
  ];
  const meta: Array<[string, string]> = [
    [t('providerLabel'), run.llm_provider_key ?? '-'],
    [t('billingModeLabel'), formatBillingModeLabel(t, run.llm_provider)],
    [t('modelLabel'), run.model ?? '-'],
    [t('computedCostLabel'), `${run.computed_cost_cents ?? 0}¢`],
    [t('perRunCapLabel'), run.per_run_cap_cents != null ? `${run.per_run_cap_cents}¢` : '-'],
  ];

  return (
    <div className={`space-y-3 ${AGENT_RUNS_BODY_FRAME}`}>
      {slot}
      {head}

      {/* ONE content panel: what happened (status · times · chips) → the numbers (one strip, not four cards) → who paid for it (one list, not five cards) → the error · the result */}
      <section data-testid="agent-run-detail-panel" className={`${AGENT_RUN_DETAIL_PANEL_FACE} space-y-3 rounded-ds-panel border border-ds-line p-3`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Chip tone={statusTone(run.status)} dot>{t(`status_${run.status}`)}</Chip>
          {run.status === 'failed' && failureDisposition ? (
            <Chip tone={failureDisposition === 'retry_scheduled' ? 'info' : 'neutral'}>{t(`failureDisposition_${failureDisposition}`)}</Chip>
          ) : null}
          <span className="text-ds-small text-ds-ink-2">{t('startedAt')}: {toLocaleStr(run.started_at, locale, displayTimezone)}</span>
          {run.finished_at ? <span className="text-ds-small text-ds-ink-2">{t('finishedAt')}: {toLocaleStr(run.finished_at, locale, displayTimezone)}</span> : null}
          {run.model ? <Chip mono>{run.model}</Chip> : null}
          {run.trigger ? <Chip mono>{run.trigger}</Chip> : null}
        </div>

        <dl data-testid="agent-run-detail-stats" className={`${AGENT_RUN_DETAIL_STRIP_FACE} grid grid-cols-2 gap-x-4 gap-y-2 rounded-ds-control px-3 py-2 sm:grid-cols-4`}>
          {stats.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-ds-small text-ds-ink-2">{label}</dt>
              <dd className="truncate text-ds-body font-semibold text-ds-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <dl data-testid="agent-run-detail-meta" className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {meta.map(([label, value]) => (
            <div key={label} className="flex min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-ds-small text-ds-ink-2">{label}</dt>
              <dd className="min-w-0 break-all text-ds-body text-ds-ink">{value}</dd>
            </div>
          ))}
        </dl>

        {Array.isArray(run.billing_notes) && run.billing_notes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ds-small font-medium text-ds-ink-2">{t('billingNotesLabel')}</span>
            {run.billing_notes.map((note) => (
              <Chip key={note}>{note}</Chip>
            ))}
          </div>
        )}

        {/* Error message for failed runs — a failed Banner: the icon and the border say «failed» together with the words */}
        {run.status === 'failed' && errorDisplay.message && (
          <Banner tone="failed" className="rounded-ds-control">
            <div className="min-w-0">
              <p className="font-semibold">{t('errorLabel')}</p>
              <p className="mt-0.5 break-words">{errorDisplay.message}</p>
              {errorDisplay.code && (
                <p className="mt-0.5 text-ds-small text-ds-ink-2">{t('errorCodeLabel')}: {errorDisplay.code}</p>
              )}
              {/* story #3493 — next_retry_at은 미래 "약속"(재시도 예정 시각). record용
                  formatRelativeTime을 쓰면 diffMs가 음수라 0으로 clamp돼 "지금"으로
                  오표시되므로 §11-2 정본(formatScheduledAt)으로 절대 표기. */}
              {failureDisposition === 'retry_scheduled' && run.next_retry_at && (
                <p className="mt-0.5 text-ds-small text-ds-ink-2">{t('nextRetryAt')}: {formatViewerScheduledAt(run.next_retry_at, displayTimezone).display}</p>
              )}
            </div>
          </Banner>
        )}

        {/* Result summary */}
        {run.result_summary && (
          <div className="space-y-0.5">
            <p className="text-ds-small font-medium text-ds-ink-2">{t('resultSummary')}</p>
            <p className="text-ds-body text-ds-ink">{run.result_summary}</p>
          </div>
        )}
      </section>

      <AgentRunToolCallsSection
        runId={run.id}
        runStatus={run.status}
        locale={locale}
        displayTimezone={displayTimezone}
      />
    </div>
  );
}
