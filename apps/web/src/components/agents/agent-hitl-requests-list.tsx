'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Bot, Clock3, RefreshCw, TriangleAlert, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { AgentHitlPolicyEditor } from './agent-hitl-policy-editor';
import { getTriggerMemoHref } from '@/services/agent-run-history';

interface HitlRequestItem {
  id: string;
  request_type: string;
  title: string;
  prompt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';
  expires_at: string | null;
  created_at: string;
  source_memo_id: string | null;
  hitl_memo_id: string | null;
  agent_name: string | null;
  requested_for_name: string | null;
}

const AUTO_REFRESH_INTERVAL = 30_000;

function formatLocalTime(isoString: string | null) {
  if (!isoString) return null;
  return new Date(isoString).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getCountdownLabel(deadline: string | null, t: ReturnType<typeof useTranslations<'agentHitl'>>) {
  if (!deadline) return t('deadlineUnknown');
  const diffMs = new Date(deadline).getTime() - Date.now();
  if (diffMs <= 0) return t('deadlineExpired');

  const totalMinutes = Math.ceil(diffMs / 60000);
  if (totalMinutes < 60) return t('deadlineMinutes', { count: totalMinutes });

  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) return t('deadlineHours', { count: totalHours });

  return t('deadlineDays', { count: Math.ceil(totalHours / 24) });
}

export function AgentHitlRequestsList() {
  const t = useTranslations('agentHitl');
  const [requests, setRequests] = useState<HitlRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRequests = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);

    try {
      const res = await fetch('/api/v1/hitl-requests?status=pending');
      if (!res.ok) return;
      const json = await res.json() as { data?: HitlRequestItem[] };
      setRequests(json.data ?? []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchRequests();
    const interval = setInterval(() => {
      void fetchRequests(true);
    }, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchRequests]);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="glass" size="lg" onClick={() => void fetchRequests(true)}>
              <RefreshCw className={`mr-2 size-4 ${refreshing ? 'animate-spin' : ''}`} />
              {t('refresh')}
            </Button>
            <Link href="/agents" className={buttonVariants({ variant: 'glass', size: 'lg' })}>
              <ArrowLeft className="mr-2 size-4" />
              {t('backToAgents')}
            </Link>
          </div>
        )}
      />

      <AgentHitlPolicyEditor />

      <SectionCard>
        <SectionCardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('sectionTitle')}</h2>
              <p className="text-sm text-[color:var(--operator-muted)]">{t('sectionBody')}</p>
            </div>
            <Badge variant="chip">{t('pendingCount', { count: requests.length })}</Badge>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-32 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
              ))}
            </div>
          ) : requests.length === 0 ? (
            <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
          ) : (
            <div className="space-y-3">
              {requests.map((request) => (
                <div
                  key={request.id}
                  className="rounded-3xl border border-white/8 bg-white/4 px-4 py-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{request.title}</h3>
                        <Badge variant="counter">{t('pendingBadge')}</Badge>
                        <Badge variant="secondary">
                          {request.request_type === 'approval'
                            ? t('requestType_approval')
                            : request.request_type === 'input'
                              ? t('requestType_input')
                              : request.request_type === 'confirmation'
                                ? t('requestType_confirmation')
                                : request.request_type === 'escalation'
                                  ? t('requestType_escalation')
                                  : t('requestType_unknown')}
                        </Badge>
                      </div>
                      <p className="whitespace-pre-wrap text-sm text-[color:var(--operator-muted)]">{request.prompt}</p>
                      <div className="grid gap-2 text-xs text-[color:var(--operator-muted)] sm:grid-cols-2">
                        <span className="inline-flex items-center gap-1">
                          <Bot className="size-3.5" />
                          {t('agentLine', { agent: request.agent_name ?? t('unknownAgent') })}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <User className="size-3.5" />
                          {t('assigneeLine', { assignee: request.requested_for_name ?? t('unknownAssignee') })}
                        </span>
                        <span className="inline-flex items-center gap-1 text-amber-200">
                          <TriangleAlert className="size-3.5" />
                          {t('deadlineLine', { countdown: getCountdownLabel(request.expires_at, t) })}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="size-3.5" />
                          {t('createdAtLine', { time: formatLocalTime(request.created_at) ?? '-' })}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      {request.source_memo_id && (
                        <Link href={getTriggerMemoHref(request.source_memo_id)} className={buttonVariants({ variant: 'glass', size: 'sm' })}>
                          {t('openSourceMemo')}
                        </Link>
                      )}
                      {request.hitl_memo_id && (
                        <Link href={getTriggerMemoHref(request.hitl_memo_id)} className={buttonVariants({ variant: 'hero', size: 'sm' })}>
                          {t('openHitlMemo')}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
