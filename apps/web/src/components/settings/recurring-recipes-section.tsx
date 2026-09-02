'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EntityChip } from '@/components/chat/embed-card';
import { parseEntityRef, unescapeReferenceLabel } from '@/components/chat/entity-ref';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story c7abdf42 — #3337(서버 반복 스케줄러·tick)이 놓은 코어를 사람이 보고/재개하고/즉시
 * 한 회차를 돌릴 자리. 이번 라운드 권한(PO 확定③) = project owner 또는 org owner/admin만
 * (BE가 강제) — 워크플로우 탭 게이트(adminChecked && isAdmin) 안에서만 마운트되므로 이
 * 컴포넌트 자체엔 read-only 분기가 없다(도달하는 사람은 이미 admin).
 */

interface RepeatScheduleRow {
  id: string;
  project_id: string;
  definition_key: string;
  definition_title: string | null;
  repeat: string;
  next_run_at: string;
  last_run_at: string | null;
  last_story_reference_token: string | null;
  status: 'active' | 'paused';
  pause_reason: string | null;
  consecutive_failure_count: number;
}

type T = ReturnType<typeof useTranslations>;
type Action = 'run-now' | 'resume' | 'pause';

const REFERENCE_TOKEN_RE = /^\[(.*)\]\((entity:[^)]+)\)$/;

function parseReferenceToken(token: string): { label: string; href: string } | null {
  const m = token.match(REFERENCE_TOKEN_RE);
  if (!m) return null;
  return { label: unescapeReferenceLabel(m[1] ?? ''), href: m[2] ?? '' };
}

function LastStoryValue({ token, t }: { token: string | null; t: T }) {
  if (!token) return <span>{t('repeatSchedulesNone')}</span>;
  const parsed = parseReferenceToken(token);
  if (!parsed) return <span>{token}</span>;
  const ref = parseEntityRef(parsed.href);
  if (!ref) return <span>{parsed.label}</span>;
  return <EntityChip entityType={ref.entityType} entityId={ref.entityId} label={parsed.label} href={parsed.href} />;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function ScheduleRow({
  row, projectId, onChanged, t,
}: {
  row: RepeatScheduleRow;
  projectId: string;
  onChanged: (row: RepeatScheduleRow) => void;
  t: T;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const successKeyFor: Record<Action, string> = {
    'run-now': 'repeatSchedulesRunNowSuccess',
    resume: 'repeatSchedulesResumeSuccess',
    pause: 'repeatSchedulesPauseSuccess',
  };
  const busyKeyFor: Record<Action, string> = {
    'run-now': 'repeatSchedulesRunningNow',
    resume: 'repeatSchedulesResuming',
    pause: 'repeatSchedulesPausing',
  };
  const ctaKeyFor: Record<Action, string> = {
    'run-now': 'repeatSchedulesRunNowCta',
    resume: 'repeatSchedulesResumeCta',
    pause: 'repeatSchedulesPauseCta',
  };

  const act = async (action: Action) => {
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetchWithAuth(`/api/projects/${projectId}/repeat-schedules/${row.id}/${action}`, {
        method: action === 'run-now' ? 'POST' : 'PATCH',
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: RepeatScheduleRow } | null;
        if (json?.data) onChanged(json.data);
        setMessage({ type: 'success', text: t(successKeyFor[action]) });
      } else {
        const body = (await res.json().catch(() => null)) as { detail?: string; error?: { message?: string } } | null;
        setMessage({ type: 'error', text: body?.detail ?? body?.error?.message ?? t('repeatSchedulesActionFailed') });
      }
    } catch {
      setMessage({ type: 'error', text: t('repeatSchedulesActionFailed') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{row.definition_title ?? row.definition_key}</span>
          <Badge variant="outline" className="font-mono">{row.repeat}</Badge>
          <Badge variant={row.status === 'active' ? 'secondary' : 'warning'}>
            {row.status === 'active' ? t('repeatSchedulesStatusActive') : t('repeatSchedulesStatusPaused')}
          </Badge>
        </div>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void act('run-now')}>
            {busy === 'run-now' ? t(busyKeyFor['run-now']) : t(ctaKeyFor['run-now'])}
          </Button>
          {row.status === 'paused' ? (
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void act('resume')}>
              {busy === 'resume' ? t(busyKeyFor.resume) : t(ctaKeyFor.resume)}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void act('pause')}>
              {busy === 'pause' ? t(busyKeyFor.pause) : t(ctaKeyFor.pause)}
            </Button>
          )}
        </div>
      </div>

      {row.status === 'paused' && row.pause_reason ? (
        <p className="text-xs text-muted-foreground">{t('repeatSchedulesPauseReasonLabel')}: {row.pause_reason}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{t('repeatSchedulesNextRunLabel')}: {formatDateTime(row.next_run_at)}</span>
        <span>{t('repeatSchedulesLastRunLabel')}: {row.last_run_at ? formatDateTime(row.last_run_at) : t('repeatSchedulesNone')}</span>
        <span className="inline-flex items-center gap-1">
          {t('repeatSchedulesLastStoryLabel')}: <LastStoryValue token={row.last_story_reference_token} t={t} />
        </span>
      </div>

      {message ? (
        <Alert
          variant={message.type === 'success' ? 'success' : 'destructive'}
          role={message.type === 'success' ? 'status' : 'alert'}
          aria-live={message.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function RecurringRecipesSection({ projectId }: { projectId: string }) {
  const t = useTranslations('settings');
  const [rows, setRows] = useState<RepeatScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/api/projects/${projectId}/repeat-schedules`);
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: RepeatScheduleRow[] } | null;
        setRows(json?.data ?? []);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChanged = (updated: RepeatScheduleRow) => {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <h2 className="text-sm font-semibold text-foreground">{t('repeatSchedulesTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('repeatSchedulesDescription')}</p>
      </SectionCardHeader>
      <SectionCardBody>
        {loadError ? (
          <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
            <AlertDescription>{t('repeatSchedulesLoadFailed')}</AlertDescription>
          </Alert>
        ) : loading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('repeatSchedulesEmpty')}</p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {rows.map((r) => <ScheduleRow key={r.id} row={r} projectId={projectId} onChanged={handleChanged} t={t} />)}
          </div>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
