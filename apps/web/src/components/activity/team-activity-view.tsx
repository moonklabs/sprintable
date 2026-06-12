'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { getEventTypeCopy, KNOWN_EVENT_TYPE_VERBS } from '@/services/notification-display';
import { getEntityHref } from '@/components/chat/embed-card';

// ─── Types (BE ActivityStreamItem flat 실측 — 유나 doc §10 정정 정합) ──────────────
interface ActivityStreamItem {
  activity_id: string;
  project_id: string;
  actor_id: string | null;
  verb: string;
  object_type: string | null;
  object_id: string | null;
  occurred_at: string;
  source_event_ids: string[];
  recipient_ids: string[];
  recipient_types: string[];
  payload: Record<string, unknown>;
  activity_seq: number;
}

interface ActivityStreamResponse {
  items: ActivityStreamItem[];
  next_after_seq: number | null;
}

interface TeamMember {
  id: string;
  name: string | null;
  type: 'human' | 'agent';
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ALL = '__all__';
const PAGE_LIMIT = 200; // BE limit 상한
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7일 슬라이스 — 더보기 시 과거로 슬라이드

// ─── Helpers ──────────────────────────────────────────────────────────────────

// object 제목 v1(PO①): payload title-ish 있으면 사용 / 없으면 단축 id. 풀 제목 resolve=backlog.
function objectLabel(item: ActivityStreamItem): string | null {
  const p = item.payload ?? {};
  for (const key of ['title', 'name', 'object_title', 'statement']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (item.object_id) return `#${item.object_id.slice(0, 8)}`;
  return null;
}

function relativeTime(iso: string, locale: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (Math.abs(sec) < 60) return rtf.format(-sec, 'second');
  if (Math.abs(min) < 60) return rtf.format(-min, 'minute');
  if (Math.abs(hr) < 24) return rtf.format(-hr, 'hour');
  return rtf.format(-day, 'day');
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ActorAvatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || '·';
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
    >
      {initial}
    </span>
  );
}

function RowSkeleton() {
  return (
    <div className="flex animate-pulse items-start gap-3 px-3 py-2.5">
      <span className="size-7 shrink-0 rounded-full bg-muted" />
      <div className="min-w-0 flex-1 space-y-1.5 pt-1">
        <span className="block h-3 w-[70%] rounded bg-muted" />
        <span className="block h-3 w-[40%] rounded bg-muted" />
      </div>
    </div>
  );
}

function FeedRow({
  item,
  actorName,
  verbCopy,
  locale,
  deliveredLabel,
}: {
  item: ActivityStreamItem;
  actorName: string;
  verbCopy: string;
  locale: string;
  deliveredLabel: string | null;
}) {
  const label = objectLabel(item);
  const href = item.object_type && item.object_id ? getEntityHref(item.object_type, item.object_id) : null;

  return (
    <li className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition hover:bg-muted/50">
      <ActorAvatar name={actorName} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          <span className="font-medium">{actorName}</span>
          <span className="text-muted-foreground"> · {verbCopy}</span>
        </p>
        {item.object_type ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
              {item.object_type}
            </span>
            {label ? (
              href ? (
                <Link href={href} className="truncate text-primary hover:underline">
                  {label}
                </Link>
              ) : (
                <span className="truncate text-muted-foreground">{label}</span>
              )
            ) : null}
          </p>
        ) : null}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">#{item.activity_seq}</span>
          <span aria-hidden>·</span>
          <span>{relativeTime(item.occurred_at, locale)}</span>
          {deliveredLabel ? (
            <>
              <span aria-hidden>·</span>
              <span>◎ {deliveredLabel}</span>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TeamActivityView({ projectId }: { projectId: string }) {
  const t = useTranslations('teamActivity');
  const tInbox = useTranslations('inbox'); // verb 사람카피(event* 키)는 inbox 네임스페이스
  const tc = useTranslations('common');
  const locale =
    typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en';

  const [items, setItems] = useState<ActivityStreamItem[] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [oldestSince, setOldestSince] = useState(0);

  const [actorFilter, setActorFilter] = useState(ALL);
  const [verbFilter, setVerbFilter] = useState(ALL);
  const [members, setMembers] = useState<TeamMember[]>([]);

  useEffect(() => {
    fetch(`/api/members?project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { data?: TeamMember[] } | null) => {
        if (d?.data) setMembers(d.data);
      })
      .catch((err) => {
        console.error('팀 활동용 팀원 목록 로드 실패', err);
      });
  }, [projectId]);

  const memberName = useCallback(
    (id: string | null): string => {
      if (!id) return t('system'); // actor.id=null → "시스템" graceful
      return members.find((m) => m.id === id)?.name ?? `#${id.slice(0, 8)}`;
    },
    [members, t],
  );

  // ASC 페치 → client reverse(newest-first). since/until로 윈도우 한정(BE ASC-only 우회).
  const fetchSlice = useCallback(
    async (sinceMs: number, untilMs: number | null): Promise<ActivityStreamItem[] | null> => {
      const p = new URLSearchParams({
        project_id: projectId,
        limit: String(PAGE_LIMIT),
        since: new Date(sinceMs).toISOString(),
      });
      if (untilMs != null) p.set('until', new Date(untilMs).toISOString());
      if (actorFilter !== ALL) p.set('actor_id', actorFilter);
      if (verbFilter !== ALL) p.set('verb', verbFilter);

      const res = await fetch(`/api/activity-stream?${p.toString()}`, { cache: 'no-store' });
      if (res.status === 403) {
        setForbidden(true);
        return null;
      }
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: ActivityStreamResponse };
      const asc = json.data?.items ?? [];
      return [...asc].reverse();
    },
    [projectId, actorFilter, verbFilter],
  );

  // 최초 / 필터 변경 → 최근 윈도우 재로드
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setItems(null);
      setForbidden(false);
      setHasMore(true);
      const since = Date.now() - WINDOW_MS;
      const slice = await fetchSlice(since, null);
      if (cancelled) return;
      setItems(slice ?? []);
      setOldestSince(since);
      setHasMore((slice?.length ?? 0) > 0);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchSlice]);

  // 더 보기 v1 = 과거 윈도우 슬라이스 페치 후 append(dedup). before_seq 정밀 cursor는 follow-up.
  const loadMore = async () => {
    setLoadingMore(true);
    const until = oldestSince;
    const since = oldestSince - WINDOW_MS;
    const slice = await fetchSlice(since, until);
    if (slice) {
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((i) => i.activity_id));
        const fresh = slice.filter((i) => !seen.has(i.activity_id));
        return [...(prev ?? []), ...fresh];
      });
      setHasMore(slice.length > 0);
    }
    setOldestSince(since);
    setLoadingMore(false);
  };

  const actorOptions: SelectOption[] = [
    { value: ALL, label: t('filterAll') },
    ...members.map((m) => ({ value: m.id, label: m.name ?? tc('unknown') })),
  ];

  const verbOptions: SelectOption[] = useMemo(
    () => [
      { value: ALL, label: t('filterAll') },
      ...KNOWN_EVENT_TYPE_VERBS.map((v) => ({ value: v, label: getEventTypeCopy(tInbox, v) })),
    ],
    [t, tInbox],
  );

  const loading = items === null;

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('tabTeamActivity')}</h1>} />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* 정규화됨 pill + 캡션 바 (팀활동 탭만 — 시각/의미 차별화 생명선) */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/80 bg-muted/40 px-[22px] py-[11px]">
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold text-info"
            style={{
              border: '1px solid color-mix(in oklch, var(--info) 35%, transparent)',
              backgroundColor: 'color-mix(in oklch, var(--info) 8%, transparent)',
            }}
          >
            {t('normalizedPill')}
          </span>
          <span className="text-[12.5px] text-muted-foreground">{t('caption')}</span>
        </div>

        {/* 필터바 (감사 로그 필터바 톤 정합) */}
        <div className="flex-shrink-0 border-b border-border/80 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <OperatorDropdownSelect
              value={actorFilter}
              onValueChange={setActorFilter}
              options={actorOptions}
              placeholder={t('filterActor')}
              className="w-36"
            />
            <OperatorDropdownSelect
              value={verbFilter}
              onValueChange={setVerbFilter}
              options={verbOptions}
              placeholder={t('filterVerb')}
              className="w-44"
            />
          </div>
        </div>

        {/* 피드형 리스트 (audit 테이블과 대비) */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {forbidden ? (
            <div className="flex h-64 items-center justify-center">
              <EmptyState title={t('forbiddenTitle')} description={t('forbiddenDescription')} />
            </div>
          ) : loading ? (
            <div className="space-y-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <RowSkeleton key={i} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-64 items-center justify-center">
              <EmptyState
                icon={<Inbox className="size-8 text-muted-foreground/60" />}
                title={t('emptyTitle')}
                description={t('emptyDesc')}
              />
            </div>
          ) : (
            <ul className="space-y-0.5">
              {items.map((item) => {
                const delivered = item.recipient_ids.length;
                return (
                  <FeedRow
                    key={item.activity_id}
                    item={item}
                    actorName={memberName(item.actor_id)}
                    verbCopy={getEventTypeCopy(tInbox, item.verb)}
                    locale={locale}
                    deliveredLabel={delivered > 0 ? t('deliveredCount', { count: delivered }) : null}
                  />
                );
              })}
              {hasMore ? (
                <div className="pt-3 text-center">
                  <Button variant="glass" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? tc('loading') : t('loadMore')}
                  </Button>
                </div>
              ) : null}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
