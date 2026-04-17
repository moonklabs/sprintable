'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock3, Cpu, Hash, RefreshCw, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { useToast, ToastContainer } from '@/components/ui/toast';
import { canManuallyRetryRun, getRunErrorDisplay, getRunFailureDisposition, getToolAuditOutcome } from '@/services/agent-run-history';

interface ToolCallEntry {
  type?: string;
  name?: string;
  tool?: string;
  toolName?: string;
  toolSource?: 'builtin' | 'external';
  input?: unknown;
  output?: unknown;
  arguments?: unknown;
  result?: unknown;
  error?: string;
  duration_ms?: number;
  durationMs?: number;
  timestamp?: string;
  model?: string;
  tokens?: { input?: number; output?: number };
}

interface ToolAuditEntry {
  id: string;
  run_id: string | null;
  session_id: string | null;
  event_type: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'security';
  summary: string;
  payload: unknown;
  created_by: string | null;
  created_at: string;
  actor_name: string | null;
}

interface MemoryRetrievalBucket {
  queriedCount: number;
  inScopeCount: number;
  blockedCount: number;
  injectedIds: string[];
}

interface MemoryRetrievalDiagnostics {
  session: MemoryRetrievalBucket;
  longTerm: MemoryRetrievalBucket;
  totalInjected: number;
  droppedByTokenBudget: number;
}

interface ContinuityDebugInfo {
  sessionId: string | null;
  snapshotPresent: boolean;
  snapshotMemoryCount: number;
  restoredFromSnapshot: boolean;
  memoryRetrievalDiagnostics: MemoryRetrievalDiagnostics | null;
}

interface MemoryCompactionPolicy {
  keepCriteria: string[];
  deleteCriteria: string[];
  typeQuota: Record<string, number>;
  thresholds: {
    minImportance: number;
    maxAgeDays: number;
    duplicateSimilarity: number;
  };
}

interface RunDetail {
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
  tool_call_history: ToolCallEntry[] | null;
  tool_audit_trail: ToolAuditEntry[] | null;
  continuity_debug: ContinuityDebugInfo | null;
  memory_compaction_policy: MemoryCompactionPolicy | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

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

function toLocaleStr(iso: string | null, locale: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatBillingModeLabel(t: ReturnType<typeof useTranslations>, billingMode: RunDetail['llm_provider']): string {
  if (!billingMode) return '-';
  return t(`billingMode_${billingMode}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getToolCallDisplay(entry: ToolCallEntry) {
  const result = asRecord(entry.result);
  const error = typeof entry.error === 'string'
    ? entry.error
    : typeof result?.error === 'string'
      ? result.error
      : null;

  return {
    name: entry.toolName ?? entry.name ?? entry.tool ?? 'Step',
    source: entry.toolSource ?? (typeof result?.source === 'string' ? result.source : null),
    durationMs: entry.durationMs ?? entry.duration_ms ?? null,
    error,
    userReason: typeof result?.user_reason === 'string' ? result.user_reason : null,
    nextAction: typeof result?.next_action === 'string' ? result.next_action : null,
    tokens: entry.tokens,
  };
}

function getAuditPayloadField(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
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
  const { toasts, addToast, dismissToast } = useToast();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const res = await fetch(`/api/v1/agent-runs/${runId}`);
      const json = res.ok ? await res.json() : null;
      if (cancelled) return;
      setRun(json?.data ?? null);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [runId]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/v1/agent-runs/${runId}/retry`, { method: 'POST' });
      if (res.ok) {
        addToast({ title: t('retrySuccessTitle'), body: t('retrySuccessBody'), type: 'success' });
      } else {
        const json = await res.json().catch(() => null);
        addToast({ title: t('retryFailedTitle'), body: json?.error?.message ?? t('retryFailedBody'), type: 'warning' });
      }
    } catch {
      addToast({ title: t('retryFailedTitle'), body: t('retryFailedBody'), type: 'warning' });
    }
    setRetrying(false);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
        <div className="h-64 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="py-20 text-center text-[color:var(--operator-muted)]">
        {tc('noData')}
      </div>
    );
  }

  const timeline: ToolCallEntry[] = Array.isArray(run.tool_call_history) ? run.tool_call_history : [];
  const toolAuditTrail: ToolAuditEntry[] = Array.isArray(run.tool_audit_trail) ? run.tool_audit_trail : [];
  const errorDisplay = getRunErrorDisplay(run.error_message, run.last_error_code);
  const failureDisposition = getRunFailureDisposition(run);
  const canRetry = canManuallyRetryRun(run);
  const retrievalDiagnostics = run.continuity_debug?.memoryRetrievalDiagnostics ?? null;
  const compactionPolicy = run.memory_compaction_policy;

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
              <Badge variant={STATUS_BADGE_VARIANT[run.status] ?? 'outline'}>
                {t(`status_${run.status}`)}
              </Badge>
              <span className="text-xs text-[color:var(--operator-muted)]">
                {t('startedAt')}: {toLocaleStr(run.started_at, locale)}
              </span>
              {run.status === 'failed' && failureDisposition && (
                <Badge variant={failureDisposition === 'retry_scheduled' ? 'info' : 'outline'}>
                  {t(`failureDisposition_${failureDisposition}`)}
                </Badge>
              )}
              {run.finished_at && (
                <span className="text-xs text-[color:var(--operator-muted)]">
                  {t('finishedAt')}: {toLocaleStr(run.finished_at, locale)}
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
              <MetaCard label={t('sessionId')} value={run.session_id ?? '-'} />
              <MetaCard label={t('providerLabel')} value={run.llm_provider_key ?? '-'} />
              <MetaCard label={t('billingModeLabel')} value={formatBillingModeLabel(t, run.llm_provider)} />
              <MetaCard label={t('modelLabel')} value={run.model ?? '-'} />
              <MetaCard label={t('computedCostLabel')} value={`${run.computed_cost_cents ?? 0}¢`} />
              <MetaCard label={t('perRunCapLabel')} value={run.per_run_cap_cents != null ? `${run.per_run_cap_cents}¢` : '-'} />
            </div>

            {Array.isArray(run.billing_notes) && run.billing_notes.length > 0 && (
              <div className="mb-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('billingNotesLabel')}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {run.billing_notes.map((note) => (
                    <Badge key={note} variant="chip">{note}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Error message for failed runs */}
            {run.status === 'failed' && errorDisplay.message && (
              <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-400" />
                  <div>
                    <p className="text-sm font-semibold text-red-300">{t('errorLabel')}</p>
                    <p className="mt-1 text-sm text-red-200/80">{errorDisplay.message}</p>
                    {errorDisplay.code && (
                      <p className="mt-1 text-xs text-red-200/60">{t('errorCodeLabel')}: {errorDisplay.code}</p>
                    )}
                    {failureDisposition === 'retry_scheduled' && run.next_retry_at && (
                      <p className="mt-1 text-xs text-red-200/60">{t('nextRetryAt')}: {toLocaleStr(run.next_retry_at, locale)}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Result summary */}
            {run.result_summary && (
              <div className="mb-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('resultSummary')}</p>
                <p className="mt-1 text-sm text-[color:var(--operator-muted)]">{run.result_summary}</p>
              </div>
            )}

            {retrievalDiagnostics && (
              <div className="mb-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('memoryRetrievalTitle')}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <MemoryBucketCard
                    label={t('memoryRetrievalSession')}
                    bucket={retrievalDiagnostics.session}
                    queriedLabel={t('memoryRetrievalQueried')}
                    inScopeLabel={t('memoryRetrievalInScope')}
                    blockedLabel={t('memoryRetrievalBlocked')}
                    injectedIdsLabel={t('memoryRetrievalInjectedIds')}
                  />
                  <MemoryBucketCard
                    label={t('memoryRetrievalLongTerm')}
                    bucket={retrievalDiagnostics.longTerm}
                    queriedLabel={t('memoryRetrievalQueried')}
                    inScopeLabel={t('memoryRetrievalInScope')}
                    blockedLabel={t('memoryRetrievalBlocked')}
                    injectedIdsLabel={t('memoryRetrievalInjectedIds')}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-[color:var(--operator-muted)]">
                  <Badge variant="chip">{t('memoryRetrievalTotalInjected')}: {retrievalDiagnostics.totalInjected}</Badge>
                  <Badge variant="chip">{t('memoryRetrievalDropped')}: {retrievalDiagnostics.droppedByTokenBudget}</Badge>
                </div>
              </div>
            )}

            {compactionPolicy && (
              <div className="mb-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('memoryCompactionTitle')}</p>
                <p className="mt-1 text-sm text-[color:var(--operator-muted)]">
                  {t('memoryCompactionThresholds', {
                    minImportance: compactionPolicy.thresholds.minImportance,
                    maxAgeDays: compactionPolicy.thresholds.maxAgeDays,
                    duplicateSimilarity: compactionPolicy.thresholds.duplicateSimilarity,
                  })}
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <CriteriaList title={t('memoryCompactionKeep')} items={compactionPolicy.keepCriteria} />
                  <CriteriaList title={t('memoryCompactionDelete')} items={compactionPolicy.deleteCriteria} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-[color:var(--operator-muted)]">
                  {Object.entries(compactionPolicy.typeQuota).map(([type, quota]) => (
                    <Badge key={type} variant="chip">{type}: {quota}</Badge>
                  ))}
                </div>
              </div>
            )}

            {run.continuity_debug && (
              <div className="mb-4 rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{t('continuityDebugTitle')}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <MetaCard label={t('sessionId')} value={run.continuity_debug.sessionId ?? '-'} />
                  <MetaCard label={t('continuitySnapshotPresent')} value={run.continuity_debug.snapshotPresent ? t('booleanYes') : t('booleanNo')} />
                  <MetaCard label={t('continuitySnapshotCount')} value={String(run.continuity_debug.snapshotMemoryCount)} />
                  <MetaCard label={t('continuityRestored')} value={run.continuity_debug.restoredFromSnapshot ? t('booleanYes') : t('booleanNo')} />
                </div>
              </div>
            )}

            {/* Timeline */}
            <div>
              <h3 className="mb-3 text-sm font-semibold text-[color:var(--operator-foreground)]">
                {t('timeline')} ({timeline.length})
              </h3>
              {timeline.length === 0 ? (
                <p className="text-sm text-[color:var(--operator-muted)]">{t('noTimelineEntries')}</p>
              ) : (
                <div className="relative space-y-0">
                  {/* Vertical line */}
                  <div className="absolute bottom-0 left-4 top-0 w-px bg-white/12" />
                  {timeline.map((entry, idx) => {
                    const display = getToolCallDisplay(entry);
                    const isLlm = entry.type === 'llm_call' || entry.type === 'llm';
                    const isTool = entry.type === 'tool_call' || entry.type === 'tool' || Boolean(entry.toolName) || Boolean(entry.tool);
                    const hasError = Boolean(display.error);

                    return (
                      <div key={idx} className="relative flex gap-4 pb-4 pl-9">
                        <div className={`absolute left-2.5 top-1.5 size-3 rounded-full border-2 ${
                          hasError
                            ? 'border-red-400 bg-red-400/20'
                            : isLlm
                              ? 'border-[color:var(--operator-primary)] bg-[color:var(--operator-primary)]/20'
                              : 'border-emerald-400 bg-emerald-400/20'
                        }`} />
                        <div className="min-w-0 flex-1 rounded-xl border border-white/8 bg-white/4 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={isLlm ? 'info' : isTool ? (hasError ? 'destructive' : 'success') : 'outline'} className="text-[10px]">
                              {isLlm ? 'LLM' : isTool ? 'TOOL' : (entry.type ?? 'step')}
                            </Badge>
                            <span className="text-xs font-medium text-[color:var(--operator-foreground)]">
                              {isLlm ? (entry.model ?? 'LLM call') : display.name}
                            </span>
                            {display.source && (
                              <Badge variant="chip" className="text-[10px]">{display.source}</Badge>
                            )}
                            {display.durationMs != null && (
                              <span className="text-[10px] text-[color:var(--operator-muted)]">
                                {formatDuration(display.durationMs)}
                              </span>
                            )}
                            {display.tokens && (
                              <span className="text-[10px] text-[color:var(--operator-muted)]">
                                {display.tokens.input ?? 0}/{display.tokens.output ?? 0} tok
                              </span>
                            )}
                            {hasError ? (
                              <AlertTriangle className="size-3.5 text-red-400" />
                            ) : (
                              <CheckCircle2 className="size-3.5 text-emerald-400/60" />
                            )}
                          </div>
                          {hasError && (
                            <div className="mt-1 space-y-1 text-xs text-red-300/80">
                              <p>{display.error}</p>
                              {display.userReason ? <p>{display.userReason}</p> : null}
                              {display.nextAction ? <p>{display.nextAction}</p> : null}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-6">
              <h3 className="mb-3 text-sm font-semibold text-[color:var(--operator-foreground)]">
                {t('toolAuditTrail')} ({toolAuditTrail.length})
              </h3>
              {toolAuditTrail.length === 0 ? (
                <p className="text-sm text-[color:var(--operator-muted)]">{t('noToolAuditEntries')}</p>
              ) : (
                <div className="space-y-3">
                  {toolAuditTrail.map((entry) => {
                    const payload = asRecord(entry.payload);
                    const outcome = getToolAuditOutcome({ eventType: entry.event_type, payload: entry.payload });
                    const toolName = getAuditPayloadField(payload, 'tool_name') ?? entry.summary;
                    const toolSource = getAuditPayloadField(payload, 'tool_source');
                    const operatorReason = getAuditPayloadField(payload, 'operator_reason');
                    const userReason = getAuditPayloadField(payload, 'user_reason');
                    const nextAction = getAuditPayloadField(payload, 'next_action');
                    const reasonCode = getAuditPayloadField(payload, 'reason_code');
                    const serverName = getAuditPayloadField(payload, 'server_name');
                    const error = getAuditPayloadField(payload, 'error');
                    const detailSummary = getAuditPayloadField(payload, 'summary');
                    const durationMs = payload && typeof payload.duration_ms === 'number' ? payload.duration_ms : null;

                    return (
                      <div key={entry.id} className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={outcome === 'denied' ? 'destructive' : outcome === 'failed' ? 'secondary' : 'success'}>
                            {outcome === 'denied' ? t('toolAuditOutcomeDenied') : outcome === 'failed' ? t('toolAuditOutcomeFailed') : t('toolAuditOutcomeAllowed')}
                          </Badge>
                          <span className="text-sm font-medium text-[color:var(--operator-foreground)]">{toolName}</span>
                          {toolSource ? <Badge variant="chip">{t(`toolAuditSource_${toolSource}`)}</Badge> : null}
                          <span className="text-xs text-[color:var(--operator-muted)]">{toLocaleStr(entry.created_at, locale)}</span>
                        </div>
                        <div className="mt-2 grid gap-2 text-sm text-[color:var(--operator-muted)] md:grid-cols-2">
                          <div>
                            <span className="text-xs uppercase tracking-[0.16em]">{t('toolAuditActorLabel')}</span>
                            <p className="mt-1 text-[color:var(--operator-foreground)]">{entry.actor_name ?? run.agent_name ?? t('unknownAgent')}</p>
                          </div>
                          <div>
                            <span className="text-xs uppercase tracking-[0.16em]">{t('toolAuditEventLabel')}</span>
                            <p className="mt-1 break-all text-[color:var(--operator-foreground)]">{entry.event_type}</p>
                          </div>
                          {reasonCode ? (
                            <div>
                              <span className="text-xs uppercase tracking-[0.16em]">{t('toolAuditReasonCodeLabel')}</span>
                              <p className="mt-1 break-all text-[color:var(--operator-foreground)]">{reasonCode}</p>
                            </div>
                          ) : null}
                          {durationMs != null ? (
                            <div>
                              <span className="text-xs uppercase tracking-[0.16em]">{t('duration')}</span>
                              <p className="mt-1 text-[color:var(--operator-foreground)]">{formatDuration(durationMs)}</p>
                            </div>
                          ) : null}
                          {serverName ? (
                            <div>
                              <span className="text-xs uppercase tracking-[0.16em]">{t('toolAuditServerLabel')}</span>
                              <p className="mt-1 text-[color:var(--operator-foreground)]">{serverName}</p>
                            </div>
                          ) : null}
                        </div>
                        {operatorReason ? (
                          <div className="mt-3 rounded-2xl border border-white/8 bg-white/3 px-3 py-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--operator-muted)]">{t('toolAuditOperatorReasonLabel')}</p>
                            <p className="mt-1 text-sm text-[color:var(--operator-foreground)]">{operatorReason}</p>
                          </div>
                        ) : null}
                        {userReason ? (
                          <div className="mt-3 rounded-2xl border border-white/8 bg-white/3 px-3 py-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--operator-muted)]">{t('toolAuditUserReasonLabel')}</p>
                            <p className="mt-1 text-sm text-[color:var(--operator-foreground)]">{userReason}</p>
                          </div>
                        ) : null}
                        {nextAction ? (
                          <div className="mt-3 rounded-2xl border border-white/8 bg-white/3 px-3 py-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--operator-muted)]">{t('toolAuditNextActionLabel')}</p>
                            <p className="mt-1 text-sm text-[color:var(--operator-foreground)]">{nextAction}</p>
                          </div>
                        ) : null}
                        {error ? (
                          <p className="mt-3 text-sm text-red-300/80">{error}</p>
                        ) : null}
                        {!operatorReason && !userReason && !nextAction && detailSummary ? (
                          <p className="mt-3 text-sm text-[color:var(--operator-muted)]">{detailSummary}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </SectionCardBody>
        </SectionCard>
      </div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
      <div className="flex items-center gap-2 text-[color:var(--operator-muted)]">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold text-[color:var(--operator-foreground)]">{value}</p>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/3 px-4 py-3">
      <p className="text-xs text-[color:var(--operator-muted)]">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-[color:var(--operator-foreground)]">{value}</p>
    </div>
  );
}

function MemoryBucketCard({
  label,
  bucket,
  queriedLabel,
  inScopeLabel,
  blockedLabel,
  injectedIdsLabel,
}: {
  label: string;
  bucket: MemoryRetrievalBucket;
  queriedLabel: string;
  inScopeLabel: string;
  blockedLabel: string;
  injectedIdsLabel: string;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/3 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
      <p className="font-medium text-[color:var(--operator-foreground)]">{label}</p>
      <div className="mt-2 space-y-1">
        <p>{queriedLabel}: {bucket.queriedCount}</p>
        <p>{inScopeLabel}: {bucket.inScopeCount}</p>
        <p>{blockedLabel}: {bucket.blockedCount}</p>
        <p className="break-all">{injectedIdsLabel}: {bucket.injectedIds.length > 0 ? bucket.injectedIds.join(', ') : '-'}</p>
      </div>
    </div>
  );
}

function CriteriaList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/3 px-4 py-3">
      <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[color:var(--operator-muted)]">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
