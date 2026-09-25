'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { OperatorDropdownSelect, type SelectOption } from '@/components/ui/operator-dropdown-select';
import { getEventTypeCopy, KNOWN_EVENT_TYPE_VERBS } from '@/services/notification-display';
import { getEntityHref } from '@/components/chat/embed-card';
import { cn } from '@/lib/utils';
import { memberLookup, memberOptionLabels } from '@/lib/member-display';
import { fetchWithAuth } from '@/lib/db/client';
import { withProjectParam } from '@/lib/with-project-param';
import { dateKeysToInstants, defaultPastDaysDateRange, resolveDisplayTimezone } from '@/components/content/schedule-format';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

// ─── Types (BE ActivityStreamItem flat 실측 — doc §10 정정 정합) ──────────────
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
  // story #4297 — order=desc(최신부터) 커서. 다음(더 오래된) 쪽은 before_seq=next_before_seq. null이면 더 없음.
  next_before_seq?: number | null;
}

interface ActivityPage {
  items: ActivityStreamItem[];
  nextBeforeSeq: number | null;
}

// story #4297(까디르 델타) — 조회 결과만 돌려주고 상태는 안 건드린다. 부르는 쪽이 세대를 확인한 **뒤에** 반영한다(늦게 온 옛 조건의 403이
// 새 조건 화면을 «접근 불가»로 덮지 않게).
type ActivityFetch = { kind: 'ok'; page: ActivityPage } | { kind: 'forbidden' } | { kind: 'error' };

interface TeamMember {
  id: string;
  name: string | null;
  type: 'human' | 'agent';
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ALL = '__all__';
const PAGE_LIMIT = 200; // BE limit 상한
const OBJECT_TYPES = ['story', 'epic', 'sprint', 'task', 'doc', 'conversation', 'meeting', 'memo'];

// story #4280 — 기본 기간(최근 7일)은 표시 시간대(조직 timezone → 없으면 브라우저) 기준 «오늘»으로(예전 UTC 날짜 자르기는 KST 00~09시에 «어제»).
const DEFAULT_RANGE_PAST_DAYS = 7;

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

// actor=primary 톤 / 시스템(actor_id=null)=muted — "사람·에이전트 행동 vs 시스템" 시각 구분(권고1).
function ActorAvatar({ name, isSystem }: { name: string; isSystem: boolean }) {
  const initial = name.trim().charAt(0).toUpperCase() || '·';
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        isSystem ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary',
      )}
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
  // story #4231 3차(PO 02:34Z) — 활동 항목은 자기 프로젝트(item.project_id)를 싣는다(4241과 같은 규칙).
  const href = item.object_type && item.object_id
    ? getEntityHref(item.object_type, item.object_id, (h) => withProjectParam(h, item.project_id))
    : null;

  return (
    <li className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition hover:bg-muted/50">
      <ActorAvatar name={actorName} isSystem={item.actor_id === null} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          <span className="font-medium">{actorName}</span>
          <span className="text-muted-foreground"> · {verbCopy}</span>
        </p>
        {item.object_type ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary-foreground">
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
  const { addToast } = useToast();
  const locale =
    typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en';

  const [items, setItems] = useState<ActivityStreamItem[] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  // story #4297 — «더 보기» 커서: 지금까지 받은 가장 오래된 활동의 activity_seq(서버가 준 next_before_seq). null이면 더 없음.
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
  // story #4297(까디르 판정) — 필터 · 날짜 · 프로젝트가 바뀌어 첫 쪽을 다시 받을 때마다 세대를 올린다. 그 전에 출발한 «더 보기» 응답이
  // 늦게 오면 새 결과에 옛 행 · 옛 커서를 붙였다 — 출발 때 세대와 다르면 버린다.
  const generationRef = useRef(0);

  // 필터 (AC③: project[암묵]·actor·object·verb·time range)
  const [actorFilter, setActorFilter] = useState(ALL);
  const [verbFilter, setVerbFilter] = useState(ALL);
  const [objectTypeFilter, setObjectTypeFilter] = useState(ALL);
  const { orgTimezone } = useDashboardContext();
  const displayTimezone = resolveDisplayTimezone(orgTimezone).tz;
  const [{ from: initFrom, to: initTo }] = useState(() => defaultPastDaysDateRange(displayTimezone, DEFAULT_RANGE_PAST_DAYS));
  const [fromDate, setFromDate] = useState(initFrom);
  const [toDate, setToDate] = useState(initTo);

  const [members, setMembers] = useState<TeamMember[]>([]);
  // [SID:4286] 팀원 목록을 다 불러왔는지(성공 · 실패 모두 끝) — 활동 목록이 먼저 오면 불러오는 중엔 이름 칸을 비워 둔다.
  const [membersLoaded, setMembersLoaded] = useState(false);

  useEffect(() => {
    fetchWithAuth(`/api/members?project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { data?: TeamMember[] } | null) => {
        if (d?.data) setMembers(d.data);
      })
      .catch((err) => {
        console.error('팀 활동용 팀원 목록 로드 실패', err);
      })
      .finally(() => setMembersLoaded(true));
  }, [projectId]);
  const nameById = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m.name])) as Record<string, string | null>,
    [members],
  );

  const memberName = useCallback(
    (id: string | null): string => {
      if (!id) return t('system'); // actor.id=null → "시스템" graceful
      // [SID:4286] 구성원 id 조각(#앞 8자)을 이름 칸에 싣지 않는다 — 표에 없음 → «알 수 없는 구성원» · 불러오는 중 → 빈 칸.
      return memberLookup(nameById, id, tc, { loaded: membersLoaded })?.label ?? '';
    },
    [nameById, membersLoaded, t, tc],
  );

  // story #4297 — 최신부터 한 쪽(order=desc) · 이전 쪽은 before_seq 커서. 예전엔 오름차순 LIMIT를 받아 뒤집어, 창 안 활동이 200건을 넘으면
  // 가장 오래된 200건만 보였다(바쁜 조직은 최신 활동이 영영 안 보임). 기간(from/to)은 경계로만 쓰고, 끝까지 잇는 건 서버 커서다.
  // story #4280(까디르 검수 P2) — 경계는 UTC ISO 문자열 또는 null(날짜 칸을 비움 = 그 방향 경계 없음).
  const fetchPage = useCallback(
    async (since: string | null, until: string | null, beforeSeq: number | null): Promise<ActivityFetch> => {
      const p = new URLSearchParams({ project_id: projectId, limit: String(PAGE_LIMIT), order: 'desc' });
      if (since) p.set('since', since);
      if (until) p.set('until', until);
      if (beforeSeq !== null) p.set('before_seq', String(beforeSeq));
      if (actorFilter !== ALL) p.set('actor_id', actorFilter);
      if (verbFilter !== ALL) p.set('verb', verbFilter);
      if (objectTypeFilter !== ALL) p.set('object_type', objectTypeFilter);

      try {
        const res = await fetchWithAuth(`/api/activity-stream?${p.toString()}`, { cache: 'no-store' });
        if (res.status === 403) return { kind: 'forbidden' };
        if (!res.ok) return { kind: 'error' };
        const json = (await res.json()) as { data?: ActivityStreamResponse };
        return { kind: 'ok', page: { items: json.data?.items ?? [], nextBeforeSeq: json.data?.next_before_seq ?? null } };
      } catch {
        return { kind: 'error' };
      }
    },
    [projectId, actorFilter, verbFilter, objectTypeFilter],
  );

  // 시간 범위 경계(ms). until은 toDate 끝(23:59:59), since 하한은 fromDate 시작.
  // story #4280 — 날짜 칸은 표시 시간대의 날짜라 경계도 그 시간대의 자정 · 자정 직전으로(예전 `new Date('…T00:00:00')`은 브라우저 시간대 자정).
  const rangeFrom = useMemo(() => dateKeysToInstants(fromDate, toDate, displayTimezone).from, [fromDate, toDate, displayTimezone]);
  const rangeTo = useMemo(() => dateKeysToInstants(fromDate, toDate, displayTimezone).to, [fromDate, toDate, displayTimezone]);

  // 최초 / 필터 변경 → 선택 범위 [from, to]의 최신 한 쪽(시작 날짜를 비우면 과거 경계 없음 — 커서가 끝까지 잇는다).
  // story #4297 — 4280이 둔 «빈 시작 = 최근 7일 창 + 7일씩 과거로» 지름길은 이 커서로 대체(빈 주를 만나면 «더 없음»으로 끝났다).
  useEffect(() => {
    let cancelled = false;
    const generation = ++generationRef.current;
    async function load() {
      setItems(null);
      setForbidden(false);
      setNextBeforeSeq(null);
      setLoadingMore(false); // 옛 조건의 «더 보기»가 걸려 있어도 새 목록의 버튼은 막히지 않게(그 응답은 세대가 달라 버려진다)
      const result = await fetchPage(rangeFrom, rangeTo, null);
      if (cancelled || generation !== generationRef.current) return;
      if (result.kind === 'forbidden') setForbidden(true);
      const page = result.kind === 'ok' ? result.page : null;
      setItems(page?.items ?? []);
      setNextBeforeSeq(page?.nextBeforeSeq ?? null);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchPage, rangeFrom, rangeTo]);

  // 더 보기 = 같은 경계 안에서 지금까지 받은 가장 오래된 활동보다 이전 쪽(before_seq). 실패하면 커서를 그대로 둬 다시 누르면 다시 시도.
  const loadMore = async () => {
    if (nextBeforeSeq === null || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const result = await fetchPage(rangeFrom, rangeTo, nextBeforeSeq);
      if (generation !== generationRef.current) return; // 그 사이 첫 쪽을 다시 받았다 — 옛 조건의 응답은 버린다(토스트 · 권한 표시도 없음).
      if (result.kind === 'forbidden') {
        setForbidden(true);
        return;
      }
      const page = result.kind === 'ok' ? result.page : null;
      if (page) {
        setItems((prev) => {
          const seen = new Set((prev ?? []).map((i) => i.activity_id));
          return [...(prev ?? []), ...page.items.filter((i) => !seen.has(i.activity_id))];
        });
        setNextBeforeSeq(page.nextBeforeSeq);
      } else {
        // story #4297(유나 후속 · PO) — 무음 실패였다. 알리고, 커서는 그대로라 버튼을 다시 누르면 다시 시도(결재함 알림과 같은 공용 문구).
        addToast({ title: tc('loadMoreFailed'), type: 'error' });
      }
    } finally {
      // 옛 조건의 요청이 늦게 끝나도 새 조건에서 도는 «더 보기»의 진행 표시를 끄지 않게 — 세대가 같을 때만 푼다(새 첫 쪽 로드가 이미 풀었다).
      if (generation === generationRef.current) setLoadingMore(false);
    }
  };

  // ─── Dropdown options ──────────────────────────────────────────────────────
  // [SID:4286 · 유나 규칙] 드롭다운 선택지는 타입 표식이 없어 라벨이 타입을 대신 · 같은 라벨이 둘 이상이면 행 꼬리(한 규칙).
  const actorLabelById = memberOptionLabels(members, tc);
  const actorOptions: SelectOption[] = [
    { value: ALL, label: t('filterAll') },
    ...members.map((m) => ({ value: m.id, label: actorLabelById.get(m.id) ?? '' })),
  ];

  const objectTypeOptions: SelectOption[] = [
    { value: ALL, label: t('filterAll') },
    ...OBJECT_TYPES.map((ot) => ({ value: ot, label: ot })),
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
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('tabTeamActivity')}</h1>} showContextChip />

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

        {/* 필터바 (감사 로그 필터바 톤 정합 — actor·object·verb·time range·AC③) */}
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
                value={objectTypeFilter}
                onValueChange={setObjectTypeFilter}
                options={objectTypeOptions}
                placeholder={t('filterObject')}
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
                icon={<Inbox className="size-8 text-muted-foreground" />}
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
              {nextBeforeSeq !== null ? (
                <li className="pt-3 text-center">
                  <Button variant="glass" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? tc('loading') : t('loadMore')}
                  </Button>
                </li>
              ) : (
                // story #4297(유나 판정) — 버튼만 사라지면 실패인지 끝인지 못 가른다. 이 목록의 끝은 «기간 안의 끝»이라, 시작일이 있으면
                // 더 이전으로 가는 길(시작일 앞당기기)을 말한다. 0건이면 이 목록 대신 빈 상태가 그려지고(위), 더 보기 실패는 커서가 남아 버튼이 그대로다.
                <li className="pt-3 text-center text-xs text-muted-foreground">
                  {rangeFrom ? t('endOfRange') : t('endOfAll')}
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
