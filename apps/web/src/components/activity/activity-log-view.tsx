'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import { deriveAuditProofState } from './derive-audit-proof-state';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';

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
// story #3228(버그사냥, 카디르) — actionFilter가 debounce 없이 buildParams/fetchLogs의
// useCallback 의존값이라, 타이핑 1글자당 이펙트가 재실행돼 네트워크 요청이 그대로
// 발사됐다(실측: 50자 타이핑 → /api/activity-logs 요청 정확히 50건, 1:1). 긴 문자열을
// 빠르게 입력하면(예: 2000자+) 수백~수천 건이 짧은 시간에 몰려 브라우저 커넥션풀이
// 고갈(ERR_INSUFFICIENT_RESOURCES)되고, 그 요청들이 비동기로 거의 동시에 귀환하며
// 겹쳐 부르는 setState 폭주가 React #185(Maximum update depth exceeded)로 이어져
// 페이지 전체가 크래시했다. 근본 처방은 "왜 렌더가 자기를 다시 트리거하는가"를 끊는
// 디바운스 — 300ms는 이 코드베이스의 다른 텍스트필터(예: 검색창) 관례와 동일 값.
const ACTION_FILTER_DEBOUNCE_MS = 300;
// 방어선(2중) — 이 필드는 활동 로그의 action 문자열 필터일 뿐 자유 텍스트 입력이 아니다.
// 실제 action 값들(예: "created", "updated_status")보다 압도적으로 넉넉한 상한.
const ACTION_FILTER_MAX_LENGTH = 200;

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
  const [loadError, setLoadError] = useState(false);

  const [actorFilter, setActorFilter] = useState(ALL);
  const [actionFilter, setActionFilter] = useState(ALL);
  // story #3228 — buildParams/fetchLogs는 이 debounce된 값을 쓴다(원본 actionFilter는
  // input의 controlled value로만 쓰여 타이핑이 시각적으로는 즉시 반영됨 — 지연되는 건
  // 네트워크 재조회뿐).
  const [debouncedActionFilter, setDebouncedActionFilter] = useState(ALL);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedActionFilter(actionFilter), ACTION_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [actionFilter]);
  const [entityTypeFilter, setEntityTypeFilter] = useState(ALL);
  const [{ from: initFrom, to: initTo }] = useState(getDefaultDates);
  const [fromDate, setFromDate] = useState(initFrom);
  const [toDate, setToDate] = useState(initTo);

  const [members, setMembers] = useState<TeamMember[]>([]);

  // fetch team members for actor dropdown
  useEffect(() => {
    fetchWithAuth(`/api/members?project_id=${projectId}`)
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
      if (debouncedActionFilter !== ALL) p.set('action', debouncedActionFilter);
      if (entityTypeFilter !== ALL) p.set('entity_type', entityTypeFilter);
      if (fromDate) p.set('from', `${fromDate}T00:00:00`);
      if (toDate) p.set('to', `${toDate}T23:59:59`);
      return p;
    },
    [projectId, actorFilter, debouncedActionFilter, entityTypeFilter, fromDate, toDate],
  );

  const fetchLogs = useCallback(
    async (nextOffset = 0) => {
      const res = await fetchWithAuth(`/api/activity-logs?${buildParams(nextOffset)}`);
      if (res.status === 403) { setForbidden(true); return null; }
      if (!res.ok) return null;
      const json = await res.json() as { data?: ActivityLogResponse };
      return json.data ?? null;
    },
    [buildParams],
  );

  // story #2000: fetchLogs 내부 raw fetch가 네트워크 단에서 throw하면(오프라인 등) try 없이
  // setLoading(false)가 영영 안 불려 스켈레톤이 무한행 — 세 진입점(load/loadMore/reload)
  // 모두 try/catch/finally로 봉합, 기존 forbidden 패턴과 동형으로 loadError 상태+reload 재사용.

  // reset + reload on filter change
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setForbidden(false);
      setLoadError(false);
      setOffset(0);
      try {
        const result = await fetchLogs(0);
        if (cancelled) return;
        setItems(result?.items ?? []);
        setTotal(result?.total ?? 0);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [fetchLogs]);

  const loadMore = async () => {
    const nextOffset = offset + PAGE_SIZE;
    setLoadingMore(true);
    try {
      const result = await fetchLogs(nextOffset);
      if (result) {
        setItems((prev) => [...prev, ...result.items]);
        setOffset(nextOffset);
        setTotal(result.total);
      }
    } catch {
      // 더보기 실패는 조용히 두고 버튼을 그대로 남겨(재클릭으로 재시도 가능).
    } finally {
      setLoadingMore(false);
    }
  };

  const reload = async () => {
    setForbidden(false);
    setLoadError(false);
    setLoading(true);
    setOffset(0);
    try {
      const result = await fetchLogs(0);
      setItems(result?.items ?? []);
      setTotal(result?.total ?? 0);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
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
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />

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
                maxLength={ACTION_FILTER_MAX_LENGTH}
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
          ) : loadError ? (
            <div className="flex h-64 items-center justify-center">
              <EmptyState
                title={tc('error')}
                description={tc('errorDescription')}
                action={
                  <Button variant="glass" size="sm" onClick={reload}>
                    <RefreshCw className="mr-1.5 size-3.5" />
                    {tc('retry')}
                  </Button>
                }
              />
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

// story #2923(P0-E AQ4, 그라운딩 발견) — actor_type 무관하게 항상 human prop으로만 넘겨(agent
// prop 미사용) 시안의 "아바타 shape로 human/agent 구분"이 이 표면에서 안 걸렸다. AuditRow가
// agent prop을 이제 실제로 그려(proof-capsule.tsx 처방) — actor_type==='agent'만 agent로,
// 그 외(human·null=미상)는 기존처럼 human으로(보수적 기본값, storage-uploader-avatar.tsx
// 선례와 동형 — 지어내지 않음). auditClaim/auditContextTooltip과 동형 패턴(순수함수 export)으로
// 렌더 없이 유닛테스트 가능하게 분리.
export function auditActorProps(item: ActivityLogItem): {
  human?: { name: string; role: string };
  agent?: { name: string; initial: string };
} {
  if (!item.actor_name) return {};
  if (item.actor_type === 'agent') return { agent: { name: item.actor_name, initial: item.actor_name.slice(0, 1) } };
  return { human: { name: item.actor_name, role: item.actor_type ?? 'human' } };
}

function ActivityRow({ item }: { item: ActivityLogItem }) {
  // story #3493 — 감사로그 created_at은 "기록" — 3436 묶음 8 정본(formatRelativeTime)
  // 으로 통일. document.documentElement.lang 수동 판독도 useLocale()로 정리(같은 뜻,
  // 정본 훅 사용).
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const time = formatRelativeTime(item.created_at, locale, displayTimezone);
  const { human, agent } = auditActorProps(item);
  return (
    <div title={auditContextTooltip(item)}>
      <ProofCapsule
        density="audit"
        proofState={deriveAuditProofState(item.action)}
        stateLabel={item.action}
        claim={auditClaim(item)}
        now={time}
        human={human}
        agent={agent}
      />
    </div>
  );
}
