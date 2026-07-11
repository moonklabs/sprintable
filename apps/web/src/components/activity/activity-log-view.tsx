'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import { deriveAuditProofState } from './derive-audit-proof-state';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActivityLogItem {
  id: string;
  project_id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_type: 'human' | 'agent' | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_title: string | null;
  context: Record<string, unknown> | null;
  created_at: string;
}

interface ActivityLogResponse {
  items: ActivityLogItem[];
  total: number;
  limit: number;
  offset: number;
}

interface TeamMember {
  id: string;
  name: string | null;
  type: 'human' | 'agent';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL = '__all__';
const PAGE_SIZE = 30;

const ENTITY_TYPES = ['story', 'epic', 'sprint', 'memo', 'task', 'agent_run', 'doc', 'meeting'];

function getDefaultDates() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 7);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

// ─── Row skeleton ─────────────────────────────────────────────────────────────

function RowSkeleton() {
  return <div className="h-9 animate-pulse rounded-[6px] bg-muted" />;
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ActivityLogViewProps {
  projectId: string;
}

export function ActivityLogView({ projectId }: ActivityLogViewProps) {
  const t = useTranslations('activityLog');
  const tc = useTranslations('common');

  const [items, setItems] = useState<ActivityLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [actorFilter, setActorFilter] = useState(ALL);
  const [actionFilter, setActionFilter] = useState(ALL);
  const [entityTypeFilter, setEntityTypeFilter] = useState(ALL);
  const [{ from: initFrom, to: initTo }] = useState(getDefaultDates);
  const [fromDate, setFromDate] = useState(initFrom);
  const [toDate, setToDate] = useState(initTo);

  const [members, setMembers] = useState<TeamMember[]>([]);

  // fetch team members for actor dropdown
  useEffect(() => {
    fetch(`/api/members?project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { data?: TeamMember[] } | null) => {
        if (data?.data) setMembers(data.data);
      })
      .catch((err) => { console.error('활동 로그용 팀원 목록 로드 실패', err); });
  }, [projectId]);

  const buildParams = useCallback(
    (nextOffset = 0) => {
      const p = new URLSearchParams({ project_id: projectId, limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (actorFilter !== ALL) p.set('actor_id', actorFilter);
      if (actionFilter !== ALL) p.set('action', actionFilter);
      if (entityTypeFilter !== ALL) p.set('entity_type', entityTypeFilter);
      if (fromDate) p.set('from', `${fromDate}T00:00:00`);
      if (toDate) p.set('to', `${toDate}T23:59:59`);
      return p;
    },
    [projectId, actorFilter, actionFilter, entityTypeFilter, fromDate, toDate],
  );

  const fetchLogs = useCallback(
    async (nextOffset = 0) => {
      const res = await fetch(`/api/activity-logs?${buildParams(nextOffset)}`);
      if (res.status === 403) { setForbidden(true); return null; }
      if (!res.ok) return null;
      const json = await res.json() as { data?: ActivityLogResponse };
      return json.data ?? null;
    },
    [buildParams],
  );

  // reset + reload on filter change
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setForbidden(false);
      setOffset(0);
      const result = await fetchLogs(0);
      if (cancelled) return;
      setItems(result?.items ?? []);
      setTotal(result?.total ?? 0);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [fetchLogs]);

  const loadMore = async () => {
    const nextOffset = offset + PAGE_SIZE;
    setLoadingMore(true);
    const result = await fetchLogs(nextOffset);
    if (result) {
      setItems((prev) => [...prev, ...result.items]);
      setOffset(nextOffset);
      setTotal(result.total);
    }
    setLoadingMore(false);
  };

  const reload = () => {
    setForbidden(false);
    setLoading(true);
    setOffset(0);
    fetchLogs(0).then((result) => {
      setItems(result?.items ?? []);
      setTotal(result?.total ?? 0);
      setLoading(false);
    });
  };

  // ─── Dropdown options ──────────────────────────────────────────────────────

  const actorOptions: SelectOption[] = [
    { value: ALL, label: t('filterAll') },
    ...members.map((m) => ({ value: m.id, label: m.name ?? tc('unknown') })),
  ];

  const entityTypeOptions: SelectOption[] = [
    { value: ALL, label: t('filterAll') },
    ...ENTITY_TYPES.map((et) => ({ value: et, label: et })),
  ];

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filters */}
        <div className="flex-shrink-0 border-b border-border/80 px-6 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex flex-wrap items-center gap-2">
              <OperatorDropdownSelect
                value={actorFilter}
                onValueChange={setActorFilter}
                options={actorOptions}
                placeholder={t('filterActor')}
                className="w-36"
              />
              <OperatorDropdownSelect
                value={entityTypeFilter}
                onValueChange={setEntityTypeFilter}
                options={entityTypeOptions}
                placeholder={t('filterEntityType')}
                className="w-36"
              />
              <input
                type="text"
                value={actionFilter === ALL ? '' : actionFilter}
                onChange={(e) => setActionFilter(e.target.value || ALL)}
                placeholder={t('filterAction')}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
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

        {/* Table */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {forbidden ? (
            <div className="flex h-64 items-center justify-center">
              <EmptyState title={t('forbiddenTitle')} description={t('forbiddenDescription')} />
            </div>
          ) : loading ? (
            <div className="space-y-1.5">
              {Array.from({ length: 8 }).map((_, i) => <RowSkeleton key={i} />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title={t('emptyTitle')}
              description={t('emptyDescription')}
              action={
                <Button variant="glass" size="sm" onClick={reload}>
                  <RefreshCw className="mr-1.5 size-3.5" />
                  {t('reload')}
                </Button>
              }
            />
          ) : (
            <div className="space-y-1.5">
              {items.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
              {offset + PAGE_SIZE < total && (
                <div className="pt-3 text-center">
                  <Button variant="glass" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? tc('loading') : t('loadMore')}
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

// ─── Sub-components ───────────────────────────────────────────────────────────

export function auditClaim(item: ActivityLogItem): string {
  if (item.entity_title) return item.entity_type ? `${item.entity_type} · ${item.entity_title}` : item.entity_title;
  return item.action;
}

export function auditContextTooltip(item: ActivityLogItem): string | undefined {
  const entries = item.context ? Object.entries(item.context) : [];
  const lines = [`action: ${item.action}`, ...entries.map(([k, v]) => `${k}: ${String(v)}`)];
  return lines.join('\n');
}

function ActivityRow({ item }: { item: ActivityLogItem }) {
  const locale = typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en';
  const time = new Date(item.created_at).toLocaleString(locale, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div title={auditContextTooltip(item)}>
      <ProofCapsule
        density="audit"
        proofState={deriveAuditProofState(item.action)}
        stateLabel={item.action}
        claim={auditClaim(item)}
        now={time}
        human={item.actor_name ? { name: item.actor_name, role: item.actor_type ?? 'human' } : undefined}
      />
    </div>
  );
}
