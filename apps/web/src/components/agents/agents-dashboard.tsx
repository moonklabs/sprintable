'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Bot, Clock3, GitBranch, History, Pause, Play, RefreshCw, Rocket, TriangleAlert, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { ToastContainer, useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getDeploymentHealthState, getDeploymentRecoveryCueKeys, hasActiveFailureSignal } from '@/services/agent-deployment-console';
import { getTriggerMemoHref } from '@/services/agent-run-history';
import { createBrowserClient } from '@/lib/db/client';

export interface AgentDeploymentCard {
  id: string;
  name: string;
  status: string;
  model: string | null;
  runtime: string;
  agent_name: string;
  persona_name: string | null;
  updated_at: string;
  last_run_at: string | null;
  latest_successful_run_at: string | null;
  executions_today: number;
  tokens_today: number;
  pending_hitl_count: number;
  next_hitl_deadline_at: string | null;
  latest_failed_run: {
    run_id: string;
    memo_id: string | null;
    failed_at: string;
    error_message: string | null;
    last_error_code: string | null;
    result_summary: string | null;
    failure_disposition: 'retry_scheduled' | 'retry_launched' | 'retry_exhausted' | 'non_retryable' | null;
    next_retry_at: string | null;
    can_manual_retry: boolean;
  } | null;
}

type TransitionAction = { deploymentId: string; name: string; targetStatus: 'ACTIVE' | 'SUSPENDED' };

function statusBadgeVariant(status: string) {
  switch (status) {
    case 'ACTIVE': return 'success' as const;
    case 'DEPLOY_FAILED': return 'destructive' as const;
    case 'SUSPENDED': return 'chip' as const;
    default: return 'outline' as const;
  }
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'ACTIVE': return 'bg-emerald-500';
    case 'DEPLOY_FAILED': return 'bg-destructive';
    case 'SUSPENDED': return 'bg-muted-foreground/60';
    case 'DEPLOYING': return 'bg-amber-500 animate-pulse';
    default: return 'bg-muted-foreground/40';
  }
}

function statusLabel(status: string, t: ReturnType<typeof useTranslations<'agents'>>) {
  switch (status) {
    case 'ACTIVE': return t('statusActive');
    case 'SUSPENDED': return t('statusSuspended');
    case 'DEPLOY_FAILED': return t('statusDeployFailed');
    case 'DEPLOYING': return t('statusDeploying');
    default: return status;
  }
}

function formatLocalTime(isoString: string, locale: string) {
  return new Date(isoString).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function formatHitlCountdown(deadline: string | null, t: ReturnType<typeof useTranslations<'agents'>>) {
  if (!deadline) return null;
  const diffMs = new Date(deadline).getTime() - Date.now();
  if (diffMs <= 0) return t('hitlDeadlineExpired');

  const totalMinutes = Math.ceil(diffMs / 60000);
  if (totalMinutes < 60) return t('hitlDeadlineMinutes', { count: totalMinutes });

  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) return t('hitlDeadlineHours', { count: totalHours });

  return t('hitlDeadlineDays', { count: Math.ceil(totalHours / 24) });
}

function healthBadgeVariant(state: ReturnType<typeof getDeploymentHealthState>) {
  switch (state) {
    case 'healthy': return 'success' as const;
    case 'recovering': return 'info' as const;
    case 'attention': return 'destructive' as const;
    case 'paused': return 'chip' as const;
    default: return 'outline' as const;
  }
}

function getFailureHeadline(failure: AgentDeploymentCard['latest_failed_run']) {
  if (!failure) return null;
  return failure.error_message ?? failure.last_error_code ?? failure.result_summary ?? null;
}

const AUTO_REFRESH_INTERVAL = 30_000;

export function AgentsDashboard({ deployments: initialDeployments }: { deployments: AgentDeploymentCard[] }) {
  const locale = useLocale();
  const t = useTranslations('agents');
  const tr = useTranslations('agentRuns');
  const tc = useTranslations('common');
  const { toasts, addToast, dismissToast } = useToast();

  const [deployments, setDeployments] = useState(initialDeployments);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pendingAction, setPendingAction] = useState<TransitionAction | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setLastRefreshed(new Date());
  }, []);

  // Show deploy success toast from sessionStorage (S462 compat)
  useEffect(() => {
    const raw = sessionStorage.getItem('agent-deploy-success');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { title: string; body: string };
      addToast({ title: parsed.title, body: parsed.body, type: 'success' });
    } finally {
      sessionStorage.removeItem('agent-deploy-success');
    }
  }, [addToast]);

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const db = createBrowserClient();
    const { data: { session } } = await db.auth.getSession();
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  };

  // Auto-refresh polling
  const fetchDeployments = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch('/api/v2/agent-deployments', { headers: authHeaders });
      if (!res.ok) return;
      const json = await res.json() as { data: AgentDeploymentCard[] | null };
      if (json.data) {
        setDeployments(json.data);
        setLastRefreshed(new Date());
      }
    } catch {
      // Silently skip refresh failures
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const start = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(fetchDeployments, AUTO_REFRESH_INTERVAL);
    };
    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchDeployments();
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchDeployments]);

  // Suspend/resume transition
  const handleTransition = async () => {
    if (!pendingAction) return;
    setTransitioning(true);
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/v2/agent-deployments/${pendingAction.deploymentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ status: pendingAction.targetStatus }),
      });
      if (!res.ok) {
        addToast({ title: t('transitionFailed'), body: t('transitionFailedBody'), type: 'warning' });
      } else {
        addToast({
          title: t('transitionSuccessTitle'),
          body: t('transitionSuccessBody', {
            name: pendingAction.name,
            status: statusLabel(pendingAction.targetStatus, t),
          }),
          type: 'success',
        });
        await fetchDeployments();
      }
    } catch {
      addToast({ title: t('transitionFailed'), body: t('transitionFailedBody'), type: 'warning' });
    } finally {
      setTransitioning(false);
      setPendingAction(null);
    }
  };

  const isSuspendAction = pendingAction?.targetStatus === 'SUSPENDED';

  return (
    <>
      <TopBarSlot
          title={<h1 className="text-sm font-medium">{t('statusTitle')}</h1>}
          actions={
            <Link href="/agents/deploy" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <Rocket className="mr-1.5 size-3.5" />
              {t('openWizard')}
            </Link>
          }
        />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        <div className="rounded-xl border border-border bg-background">
          <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">{t('statusListTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('statusListBody')}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {t('lastRefreshed', {
                  time: lastRefreshed
                    ? lastRefreshed.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
                    : '—',
                })}
              </span>
              <Badge variant="chip" className="inline-flex items-center gap-1">
                <RefreshCw className={isRefreshing ? 'size-3 animate-spin' : 'size-3'} />
                {t('autoRefreshLabel')}
              </Badge>
              <Badge variant="chip">{t('deploymentCount', { count: deployments.length })}</Badge>
            </div>
          </div>
          <div className="space-y-3 p-4">
            {deployments.length === 0 ? (
              <div className="space-y-6 py-4">
                <div className="rounded-md border border-dashed border-border bg-muted/30 px-5 py-8 text-center">
                  <Bot className="mx-auto size-10 text-primary" />
                  <h3 className="mt-4 text-lg font-semibold text-foreground">{t('emptyDeploymentsTitle')}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{t('emptyDeploymentsBody')}</p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <Link href="/agents/workflow" className={buttonVariants({ variant: 'glass', size: 'lg' })}>{t('workflowEditorCta')}</Link>
                    <Link href="/agents/deploy" className={buttonVariants({ variant: 'hero', size: 'lg' })}>{t('openWizard')}</Link>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {([
                    { icon: '📋', titleKey: 'featureTaskTitle', bodyKey: 'featureTaskBody' },
                    { icon: '⚡', titleKey: 'featureAutoTitle', bodyKey: 'featureAutoBody' },
                    { icon: '🔁', titleKey: 'featureSkillTitle', bodyKey: 'featureSkillBody' },
                  ] as const).map(({ icon, titleKey, bodyKey }) => (
                    <div key={titleKey} className="rounded-lg border border-border/60 bg-muted/20 p-4">
                      <div className="text-2xl">{icon}</div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{t(titleKey)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t(bodyKey)}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : deployments.map((deployment) => {
              const healthState = getDeploymentHealthState(deployment);
              const recoveryCues = getDeploymentRecoveryCueKeys(deployment);
              const latestFailure = hasActiveFailureSignal(deployment) ? deployment.latest_failed_run : null;

              return (
                <div key={deployment.id} className="rounded-md border border-border bg-muted/30 px-4 py-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(deployment.status)}`}
                          aria-hidden="true"
                        />
                        <h3 className="text-sm font-semibold text-foreground">{deployment.name}</h3>
                        <Badge variant={statusBadgeVariant(deployment.status)}>
                          {statusLabel(deployment.status, t)}
                        </Badge>
                        {deployment.pending_hitl_count > 0 && (
                          <Badge variant="counter">
                            {t('hitlPendingBadge', { count: deployment.pending_hitl_count })}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {deployment.persona_name
                          ? t('statusPersonaLine', { agent: deployment.agent_name, persona: deployment.persona_name })
                          : t('statusAgentLine', { agent: deployment.agent_name })}
                      </p>
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                        <span>{t('statusRuntime', { runtime: deployment.runtime })}</span>
                        <span>{t('statusModel', { model: deployment.model ?? t('statusModelUnknown') })}</span>
                        <span className="inline-flex items-center gap-1">
                          <Zap className="size-3" />
                          {t('executionsSummary', { count: deployment.executions_today })}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <RefreshCw className="size-3" />
                          {t('tokenUsageToday', { count: deployment.tokens_today })}
                        </span>
                        {deployment.pending_hitl_count > 0 && (
                          <span className="inline-flex items-center gap-1 text-amber-200 sm:col-span-2 xl:col-span-4">
                            <TriangleAlert className="size-3.5" />
                            {t('hitlDeadlineLabel', {
                              countdown: formatHitlCountdown(deployment.next_hitl_deadline_at, t) ?? t('hitlDeadlineUnknown'),
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 flex-col items-start gap-3 lg:items-end">
                      {deployment.status === 'ACTIVE' && (
                        <Button
                          variant="glass"
                          size="sm"
                          onClick={() => setPendingAction({ deploymentId: deployment.id, name: deployment.name, targetStatus: 'SUSPENDED' })}
                        >
                          <Pause className="mr-1 size-3" />
                          {t('suspendBtn')}
                        </Button>
                      )}
                      {deployment.status === 'SUSPENDED' && (
                        <Button
                          variant="glass"
                          size="sm"
                          onClick={() => setPendingAction({ deploymentId: deployment.id, name: deployment.name, targetStatus: 'ACTIVE' })}
                        >
                          <Play className="mr-1 size-3" />
                          {t('resumeBtn')}
                        </Button>
                      )}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {deployment.status === 'DEPLOY_FAILED' ? <TriangleAlert className="size-4 text-amber-300" /> : <Clock3 className="size-4" />}
                        <span>
                          {deployment.last_run_at
                            ? t('lastRunAt', { time: formatLocalTime(deployment.last_run_at, locale) })
                            : t('lastRunEmpty')}
                        </span>
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        {t('statusUpdatedAt', { time: formatLocalTime(deployment.updated_at, locale) })}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                    <div className="rounded-md border border-border bg-muted/30 px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-semibold text-foreground">{t('healthSummaryTitle')}</h4>
                          <p className="mt-1 text-xs text-muted-foreground">{t('healthSummaryBody')}</p>
                        </div>
                        <Badge variant={healthBadgeVariant(healthState)}>
                          {t(`healthStateLabel_${healthState}`)}
                        </Badge>
                      </div>
                      <p className="mt-3 text-sm text-foreground">{t(`healthStateBody_${healthState}`)}</p>

                      {latestFailure ? (
                        <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-3">
                          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('recentFailureTitle')}</p>
                          <p className="mt-1 text-sm font-medium text-foreground">
                            {getFailureHeadline(latestFailure) ?? t('recentFailureFallback')}
                          </p>
                          {latestFailure.result_summary && (
                            <p className="mt-1 text-xs text-muted-foreground">{latestFailure.result_summary}</p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{t('recentFailureAt', { time: formatLocalTime(latestFailure.failed_at, locale) })}</span>
                            {latestFailure.last_error_code && <Badge variant="outline">{latestFailure.last_error_code}</Badge>}
                            {latestFailure.failure_disposition && (
                              <Badge variant="chip">{tr(`failureDisposition_${latestFailure.failure_disposition}`)}</Badge>
                            )}
                            {latestFailure.next_retry_at && (
                              <span>{t('recoveryNextRetryAt', { time: formatLocalTime(latestFailure.next_retry_at, locale) })}</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="mt-3 text-xs text-muted-foreground">{t('recentFailureEmpty')}</p>
                      )}
                    </div>

                    <div className="rounded-md border border-border bg-muted/30 px-4 py-4">
                      <h4 className="text-sm font-semibold text-foreground">{t('recoveryCuesTitle')}</h4>
                      <p className="mt-1 text-xs text-muted-foreground">{t('recoveryCuesBody')}</p>

                      {recoveryCues.length === 0 ? (
                        <div className="mt-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-3">
                          <p className="text-sm font-medium text-foreground">{t('recoveryNoneTitle')}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{t('recoveryNoneBody')}</p>
                        </div>
                      ) : (
                        <div className="mt-3 space-y-2">
                          {recoveryCues.map((cue) => (
                            <div key={`${deployment.id}-${cue}`} className="rounded-md border border-border bg-muted/30 px-3 py-3">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <Badge variant={cue === 'retrying' ? 'info' : cue === 'manual_retry' || cue === 'inspect_failure' ? 'destructive' : 'chip'}>
                                      {t(`recoveryCueTitle_${cue}`)}
                                    </Badge>
                                  </div>
                                  <p className="mt-2 text-xs text-muted-foreground">{t(`recoveryCueBody_${cue}`)}</p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {cue === 'hitl' && (
                                    <Link href="/agents/hitl" className={buttonVariants({ variant: 'glass', size: 'sm' })}>
                                      <TriangleAlert className="mr-1 size-3" />
                                      {t('hitlQueueCta')}
                                    </Link>
                                  )}
                                  {cue === 'deploy_failed' && (
                                    <Link href="/agents/deploy" className={buttonVariants({ variant: 'glass', size: 'sm' })}>
                                      <Rocket className="mr-1 size-3" />
                                      {t('openWizard')}
                                    </Link>
                                  )}
                                  {cue === 'resume_deployment' && (
                                    <Button
                                      variant="glass"
                                      size="sm"
                                      onClick={() => setPendingAction({ deploymentId: deployment.id, name: deployment.name, targetStatus: 'ACTIVE' })}
                                    >
                                      <Play className="mr-1 size-3" />
                                      {t('resumeBtn')}
                                    </Button>
                                  )}
                                  {(cue === 'retrying' || cue === 'manual_retry' || cue === 'inspect_failure') && (
                                    <Link href="/agents/runs" className={buttonVariants({ variant: 'glass', size: 'sm' })}>
                                      <History className="mr-1 size-3" />
                                      {tr('runHistory')}
                                    </Link>
                                  )}
                                  {latestFailure?.memo_id && (cue === 'retrying' || cue === 'manual_retry' || cue === 'inspect_failure') && (
                                    <Link href={getTriggerMemoHref(latestFailure.memo_id)} className={buttonVariants({ variant: 'glass', size: 'sm' })}>
                                      {tr('openMemo')}
                                    </Link>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Suspend / Resume confirmation dialog */}
      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open && !transitioning) setPendingAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isSuspendAction ? t('suspendDialogTitle') : t('resumeDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {isSuspendAction ? t('suspendDialogBody') : t('resumeDialogBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={transitioning} onClick={() => setPendingAction(null)}>
              {tc('cancel')}
            </Button>
            <Button
              variant={isSuspendAction ? 'destructive' : 'default'}
              disabled={transitioning}
              onClick={handleTransition}
            >
              {transitioning
                ? t('transitioning')
                : isSuspendAction ? t('suspendDialogConfirm') : t('resumeDialogConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
