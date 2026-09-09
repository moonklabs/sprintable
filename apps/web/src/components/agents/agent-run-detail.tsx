'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle, ArrowLeft, Clock3, Cpu, Hash, RefreshCw, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { useToast } from '@/components/ui/toast';
import { canManuallyRetryRun, getRunErrorDisplay, getRunFailureDisposition } from '@/services/agent-run-history';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';
import { agentRunStatusBadgeVariant, type AgentRunStatus } from '@/lib/agent-run-status';
import { AgentRunToolCallsSection } from './agent-run-tool-calls-section';

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
export function toLocaleStr(iso: string | null, locale: string, displayTimezone: string): string {
  if (!iso) return '-';
  return formatRelativeTime(iso, locale, displayTimezone);
}

function formatBillingModeLabel(t: ReturnType<typeof useTranslations>, billingMode: RunDetail['llm_provider']): string {
  if (!billingMode) return '-';
  return t(`billingMode_${billingMode}`);
}

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
  const displayTimezone = resolveDisplayTimezone().tz;
  const { addToast } = useToast();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // story #1989: fetch 자체에 try/catch가 없어 네트워크 실패(오프라인 등) 시 fetch가 throw →
  // setLoading(false)가 영영 안 불려 스켈레톤이 무한 행("loading은 finally에서 해소" 하우스룰
  // 위반). loadError로 실패를 별도 상태화해 재시도 affordance를 노출한다.
  const [loadError, setLoadError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(false);
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

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/v1/agent-runs/${runId}/retry`, { method: 'POST' });
      if (res.ok) {
        addToast({ title: t('retrySuccessTitle'), body: t('retrySuccessBody'), type: 'success' });
      } else {
        // story #2485 — 그라운딩(2026-08-06): 이 라우트(POST .../retry)는 backend에
        // 존재하지 않아 항상 404다(BE 미구현 — 별도 이슈로 보고, FE에서 code로 갈라도
        // 해결 안 됨). raw 서버 message 노출만 우선 제거.
        addToast({ title: t('retryFailedTitle'), body: t('retryFailedBody'), type: 'warning' });
      }
    } catch {
      addToast({ title: t('retryFailedTitle'), body: t('retryFailedBody'), type: 'warning' });
    }
    setRetrying(false);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (loadError) {
    return (
      // story #2105 2차 — load()가 재시도 전 setLoadError(false)를 먼저 호출해(위 정의) 매
      // retryKey 변경마다 언마운트→리마운트된다.
      <div role="alert" aria-live="assertive" aria-atomic="true" className="flex flex-col items-center gap-3 py-20 text-center text-muted-foreground">
        <p>{tc('error')}</p>
        <p className="text-xs">{tc('errorDescription')}</p>
        <Button size="sm" variant="outline" onClick={() => setRetryKey((k) => k + 1)}>
          {tc('retry')}
        </Button>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        {tc('noData')}
      </div>
    );
  }

  const errorDisplay = getRunErrorDisplay(run.error_message, run.last_error_code);
  const failureDisposition = getRunFailureDisposition(run);
  const canRetry = canManuallyRetryRun(run);

  return (
    <>
      <div className="space-y-4">
        <PageHeader
          eyebrow={t('detailEyebrow')}
          title={run.agent_name ?? t('unknownAgent')}
          description={`${t('runId')}: ${run.id.slice(0, 8)}…`}
          actions={
            <div className="flex items-center gap-2">
              {canRetry && (
                <Button variant="hero" size="lg" onClick={handleRetry} disabled={retrying}>
                  <RefreshCw className={`mr-2 size-4 ${retrying ? 'animate-spin' : ''}`} />
                  {retrying ? tc('loading') : tc('retry')}
                </Button>
              )}
              <Button variant="glass" size="lg" onClick={onBack}>
                <ArrowLeft className="mr-2 size-4" />
                {t('backToList')}
              </Button>
            </div>
          }
        />

        {/* Summary stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={<Clock3 className="size-4" />} label={t('duration')} value={formatDuration(run.duration_ms)} />
          <StatCard icon={<Cpu className="size-4" />} label={t('llmCallsLabel')} value={String(run.llm_call_count)} />
          <StatCard icon={<Hash className="size-4" />} label={t('tokens')} value={`${run.input_tokens ?? 0} / ${run.output_tokens ?? 0}`} />
          <StatCard icon={<Zap className="size-4" />} label={t('cost')} value={run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '-'} />
        </div>

        {/* Status + metadata */}
        <SectionCard>
          <SectionCardHeader>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={agentRunStatusBadgeVariant(run.status)}>
                {t(`status_${run.status}`)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t('startedAt')}: {toLocaleStr(run.started_at, locale, displayTimezone)}
              </span>
              {run.status === 'failed' && failureDisposition && (
                <Badge variant={failureDisposition === 'retry_scheduled' ? 'info' : 'outline'}>
                  {t(`failureDisposition_${failureDisposition}`)}
                </Badge>
              )}
              {run.finished_at && (
                <span className="text-xs text-muted-foreground">
                  {t('finishedAt')}: {toLocaleStr(run.finished_at, locale, displayTimezone)}
                </span>
              )}
              {run.model && (
                <Badge variant="chip">{run.model}</Badge>
              )}
              {run.trigger && (
                <Badge variant="chip">{run.trigger}</Badge>
              )}
            </div>
          </SectionCardHeader>
          <SectionCardBody>
            <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <MetaCard label={t('providerLabel')} value={run.llm_provider_key ?? '-'} />
              <MetaCard label={t('billingModeLabel')} value={formatBillingModeLabel(t, run.llm_provider)} />
              <MetaCard label={t('modelLabel')} value={run.model ?? '-'} />
              <MetaCard label={t('computedCostLabel')} value={`${run.computed_cost_cents ?? 0}¢`} />
              <MetaCard label={t('perRunCapLabel')} value={run.per_run_cap_cents != null ? `${run.per_run_cap_cents}¢` : '-'} />
            </div>

            {Array.isArray(run.billing_notes) && run.billing_notes.length > 0 && (
              <div className="mb-4 rounded-xl border border-white/8 bg-white/4 px-4 py-3">
                <p className="text-sm font-medium text-foreground">{t('billingNotesLabel')}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {run.billing_notes.map((note) => (
                    <Badge key={note} variant="chip">{note}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Error message for failed runs */}
            {run.status === 'failed' && errorDisplay.message && (
              <Alert variant="destructive" className="mb-4">
                {/* story #2513 — Alert 글자가 text-foreground로 통일된 후, 색-미지정
                    아이콘은 부모의 currentColor를 상속해 variant 색을 잃는다. 명시. */}
                <AlertTriangle className="size-4 text-destructive" />
                <AlertDescription>
                  <p className="font-semibold">{t('errorLabel')}</p>
                  <p className="mt-1">{errorDisplay.message}</p>
                  {errorDisplay.code && (
                    <p className="mt-1 text-xs opacity-75">{t('errorCodeLabel')}: {errorDisplay.code}</p>
                  )}
                  {/* story #3493 — next_retry_at은 미래 "약속"(재시도 예정 시각). record용
                      formatRelativeTime을 쓰면 diffMs가 음수라 0으로 clamp돼 "지금"으로
                      오표시되므로 §11-2 정본(formatScheduledAt)으로 절대 표기. */}
                  {failureDisposition === 'retry_scheduled' && run.next_retry_at && (
                    <p className="mt-1 text-xs opacity-75">{t('nextRetryAt')}: {formatScheduledAt(run.next_retry_at, displayTimezone).display}</p>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* Result summary */}
            {run.result_summary && (
              <div className="mb-4 rounded-xl border border-white/8 bg-white/4 px-4 py-3">
                <p className="text-sm font-medium text-foreground">{t('resultSummary')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{run.result_summary}</p>
              </div>
            )}

          </SectionCardBody>
        </SectionCard>

        <AgentRunToolCallsSection
          runId={run.id}
          runStatus={run.status}
          locale={locale}
          displayTimezone={displayTimezone}
        />
      </div>
    </>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/4 px-4 py-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/3 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

