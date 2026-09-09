'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { InsightsBoardMetricCell } from '@/components/insights-board/insights-board-metric-cell';
import { InsightsBoardCommentsCell } from '@/components/insights-board/insights-board-comments-cell';
import { FollowUpDialog } from '@/components/insights-board/follow-up-dialog';
import { ReconcileResultLine } from '@/components/insights-board/reconcile-result-line';
import { parseInsightsBoardApiError } from '@/components/insights-board/insights-board-error';
import { ASSET_LABEL_PREFIX_LENGTH, aggregateGroupBucket, groupInsightsBoardRows, type InsightsBoardGroupBy } from '@/components/insights-board/group-rows';
import { DEFAULT_METRIC, METRIC_KEYS, type BoardMetric, type InsightsBoardResponse, type InsightsBoardRow, type InsightsBoardWindow } from '@/components/insights-board/types';

/**
 * story #3503 — 성과 보드 화면. BE #3502 의존(PR 브리프 헤더 참고, 이 파일 작성 시점
 * origin/develop 미착지) — GET .../insights-board는 fixture 기반 테스트로만 검증됐다.
 *
 * URL 쿼리 파라미터로 필터 상태를 갖는다(inbox/page.tsx 패턴 — router.replace +
 * { scroll:false }, 기본값이면 URL에서 생략). window만은 예외 — PO 확定(브리프 §5):
 * FE 기본값(7d)과 BE 기본값(30d)이 다르므로, 화면이 «항상» window을 명시해서 BE에
 * 보낸다(URL 표시는 기본값일 때 생략해도 되지만, 실제 fetch 쿼리엔 항상 싣는다).
 */
// PO REQUEST(2026-09-05, PR#3853 리뷰) — 정렬은 지표 선택에 «따라간다». 드롭다운
// 자체는 역할(발행시각/D+1/D+7) 3개만 갖고, 실제 BE `sort` 파라미터는 그 역할과
// 현재 선택 지표를 합성한다(예: metric=views·역할=d1 → `sort=views_d1`) — 지표를
// 바꿔도 "D+1로 본다"는 의도 자체는 유지된다(URL엔 역할만 저장, 지표는 별도
// `metric` 파라미터).
type SortRole = 'published_at' | 'd1' | 'd7';
type SortDir = 'asc' | 'desc';

const WINDOW_OPTIONS: InsightsBoardWindow[] = ['7d', '30d', '90d'];
const SORT_ROLE_OPTIONS: SortRole[] = ['published_at', 'd1', 'd7'];
const STATUS_FILTER_OPTIONS = ['pending', 'captured', 'unsupported', 'failed', 'dead_letter'] as const;
// story #3656(Phase2·FE+BE, 페드루 PO 確定 2026-09-07) — 소재/훅 묶음 토글. 다른
// 필터와 달리 이 축은 서버가 모른다(client-side groupBy, group-rows.ts) — BE 쿼리
// 파라미터로 안 보낸다(buildQuery 불변).
const GROUP_BY_OPTIONS: InsightsBoardGroupBy[] = ['none', 'asset', 'hook'];
const DEFAULT_GROUP_BY: InsightsBoardGroupBy = 'none';

// insight-snapshot-block.tsx(story #3499) METRIC_LABEL_KEYS와 동일 매핑 —
// content 네임스페이스 기존 지표 라벨 재사용(새 키를 만들지 않는다).
const METRIC_LABEL_KEYS: Record<BoardMetric, string> = {
  views: 'insightMetricViews',
  impressions: 'insightMetricImpressions',
  reach: 'insightMetricReach',
  engagements: 'insightMetricEngagements',
  clicks: 'insightMetricClicks',
  spend: 'insightMetricSpend',
  conversions: 'insightMetricConversions',
  // story #3583(페드루 PO 確定 2026-09-06) — GA4 유입 지표 2개(새 낱말 필요 — 5지표엔
  // 없던 개념이라 재사용원이 없다).
  inflow_sessions: 'insightMetricInflowSessions',
  inflow_users: 'insightMetricInflowUsers',
};

// insight-snapshot-block.tsx(story #3499)의 STATUS_LABEL_KEYS와 동일 관례 — content
// 네임스페이스 기존 키를 그대로 재사용한다(unsupported는 그 파일과 동일하게 전용 문장
// 키 하나뿐이라 이 맵에 없다, 아래 statusFilterLabel에서 별도 분기).
const STATUS_FILTER_LABEL_KEYS: Partial<Record<(typeof STATUS_FILTER_OPTIONS)[number], string>> = {
  pending: 'insightStatusPending',
  captured: 'insightStatusCaptured',
  failed: 'insightStatusFailed',
  dead_letter: 'insightStatusDeadLetter',
};

const DEFAULT_WINDOW: InsightsBoardWindow = '7d';
const DEFAULT_SORT_ROLE: SortRole = 'published_at';
const DEFAULT_SORT_DIR: SortDir = 'desc';

// story #3620 AC3 — 행 액션 「원본과 대조」의 진행 상태 3분기(진행 中·실패·완료).
type ReconcileRowState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; verdicts: Record<string, string> };

export default function InsightsBoardPage() {
  const { orgId, currentMemberType } = useDashboardContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  // story #3656 — 훅 미태깅 묶음 라벨은 새 낱말을 안 만들고 docs 네임스페이스 기존
  // 키(indexCategoryUncategorized, 「미분류」)를 재사용한다(유나 確定).
  const tDocs = useTranslations('docs');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  const windowParam = (searchParams.get('window') as InsightsBoardWindow | null) ?? DEFAULT_WINDOW;
  const channelParam = searchParams.get('channel') ?? '';
  const statusParam = searchParams.get('status') ?? '';
  const sortRoleParam = (searchParams.get('sort') as SortRole | null) ?? DEFAULT_SORT_ROLE;
  const sortDirParam = (searchParams.get('sort_dir') as SortDir | null) ?? DEFAULT_SORT_DIR;
  const rawMetricParam = searchParams.get('metric') as BoardMetric | null;
  const metricParam: BoardMetric = rawMetricParam && METRIC_KEYS.includes(rawMetricParam) ? rawMetricParam : DEFAULT_METRIC;
  // story #3617(유나 3600 AC2 기준선) — 채널 포스트 화면 「성과 보기」 링크가 이 발행의
  // publication_id를 실어 온다. 있는 강조/스크롤 메커니즘이 이 화면엔 없어서(그라운딩
  // 확認) 새로 짠다 — row가 이미 publication_id로 키가 나 있어(346행) 비용이 작다.
  const highlightParam = searchParams.get('highlight');
  // story #3656 — 소재/훅 묶음 토글. 다른 필터와 같은 URL-쿼리 관례(getter는 여기,
  // 세터는 updateQuery 재사용) — 서버 쿼리(buildQuery)엔 안 실린다(client-side뿐).
  const rawGroupByParam = searchParams.get('group_by') as InsightsBoardGroupBy | null;
  const groupByParam: InsightsBoardGroupBy = rawGroupByParam && GROUP_BY_OPTIONS.includes(rawGroupByParam)
    ? rawGroupByParam : DEFAULT_GROUP_BY;
  // 실제 BE sort 값 — 역할(published_at 고정, d1/d7은 현재 지표와 합성).
  const resolvedSort = sortRoleParam === 'published_at' ? 'published_at' : `${metricParam}_${sortRoleParam}`;

  const [rows, setRows] = useState<InsightsBoardRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  // doc a0da40c9 §21-5(유나 2026-09-05) — 제목 기본값(「[재발행] {원문 제목}」 등)을
  // 채워 보이려면 이 행의 원문 title이 필요하다 — publication_id만으론 부족해
  // row 전체를 들고 있는다.
  const [followUpRow, setFollowUpRow] = useState<InsightsBoardRow | null>(null);

  // story #3620 AC3 — 행 액션 「원본과 대조」. publication_id로 키잉(같은 화면에
  // 여러 행이 각자 진행 중일 수 있다 — follow-up 다이얼로그와 달리 대조는 모달이
  // 아니라 인라인 결과라 여러 행이 동시에 진행 가능해야 한다).
  const [reconcileState, setReconcileState] = useState<Record<string, ReconcileRowState>>({});

  const handleReconcile = useCallback(async (row: InsightsBoardRow) => {
    if (!orgId) return;
    setReconcileState((prev) => ({ ...prev, [row.publication_id]: { status: 'loading' } }));
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/publications/${row.publication_id}/reconcile`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: unknown; error?: Record<string, unknown> } | null;
        const info = parseInsightsBoardApiError(body);
        // story #3620 CHANGES(카디르 발견) — CHANNEL_CONNECTION_NOT_ACTIVE는 content
        // 네임스페이스 기존 키를 재사용하므로 humanMessageNamespace로 어느 t를 쓸지 가른다.
        const translate = info.humanMessageNamespace === 'content' ? tContent : t;
        const message = info.humanMessageKey ? translate(info.humanMessageKey) : (info.humanMessageFallback || t('reconcileErrorGeneric'));
        setReconcileState((prev) => ({ ...prev, [row.publication_id]: { status: 'error', message } }));
        return;
      }
      const json = (await res.json().catch(() => null)) as { data?: { verdicts: Record<string, string> } } | null;
      if (!json?.data) {
        setReconcileState((prev) => ({ ...prev, [row.publication_id]: { status: 'error', message: t('reconcileErrorGeneric') } }));
        return;
      }
      setReconcileState((prev) => ({
        ...prev, [row.publication_id]: { status: 'done', verdicts: json.data!.verdicts },
      }));
    } catch {
      setReconcileState((prev) => ({
        ...prev, [row.publication_id]: { status: 'error', message: t('reconcileErrorGeneric') },
      }));
    }
  }, [orgId, t, tContent]);

  const buildQuery = useCallback((cursor?: string) => {
    const qs = new URLSearchParams();
    // PO 확定(브리프 §5) — window은 사용자가 뭘 고르든 항상 명시해서 보낸다(BE 기본값
    // 30d에 조용히 기대지 않는다).
    qs.set('window', windowParam);
    if (channelParam) qs.set('channel', channelParam);
    if (statusParam) qs.set('status', statusParam);
    if (resolvedSort !== 'published_at') qs.set('sort', resolvedSort);
    if (sortDirParam !== DEFAULT_SORT_DIR) qs.set('sort_dir', sortDirParam);
    if (cursor) qs.set('cursor', cursor);
    return qs.toString();
  }, [windowParam, channelParam, statusParam, resolvedSort, sortDirParam]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setLoadErrorMessage(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/insights-board?${buildQuery()}`);
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: InsightsBoardResponse } | null;
        setRows(json?.data?.rows ?? []);
        setHasMore(json?.data?.has_more ?? false);
        setNextCursor(json?.data?.next_cursor ?? null);
      } else {
        const body = (await res.json().catch(() => null)) as { detail?: unknown; error?: Record<string, unknown> } | null;
        const info = parseInsightsBoardApiError(body);
        setLoadErrorMessage(info.humanMessageKey ? t(info.humanMessageKey) : (info.humanMessageFallback || t('loadError')));
      }
    } catch {
      setLoadErrorMessage(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [orgId, buildQuery, t]);

  useEffect(() => { void load(); }, [load]);

  // story #3617 — 채널 포스트 화면 「성과 보기」에서 ?highlight={publication_id}로
  // 들어오면 해당 행으로 스크롤+강조(짧게, 3초 뒤 해제). 행이 아직 안 실렸으면
  // (loading 中·다음 페이지에 있음 등) 조용히 스킵 — 없으면 보드 최상단으로
  // 끝내는 것이 AC의 명시 대체 경로다(새 로딩/재조회 로직 0).
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  useEffect(() => {
    if (!highlightParam || loading || rows.length === 0) return;
    const el = rowRefs.current.get(highlightParam);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedRowId(highlightParam);
    const timer = setTimeout(() => setHighlightedRowId(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightParam, loading, rows]);

  const handleLoadMore = useCallback(async () => {
    if (!orgId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/insights-board?${buildQuery(nextCursor)}`);
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: InsightsBoardResponse } | null;
        setRows((prev) => [...prev, ...(json?.data?.rows ?? [])]);
        setHasMore(json?.data?.has_more ?? false);
        setNextCursor(json?.data?.next_cursor ?? null);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [orgId, nextCursor, loadingMore, buildQuery]);

  function updateQuery(next: Record<string, string | null>) {
    const qs = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '') qs.delete(key);
      else qs.set(key, value);
    }
    const query = qs.toString();
    router.replace(`/organization/insights-board${query ? `?${query}` : ''}`, { scroll: false });
  }

  // PO REQUEST — 라벨은 지표 이름을 포함한다("D+1 조회" 등, 지표를 바꾸면 라벨도
  // 같이 바뀐다). insightsBoardSortD1/D7은 이 보드 전용 신규 템플릿 키(content
  // 네임스페이스엔 "D+1"이라는 개념 자체가 없어 재사용할 기존 키가 없다).
  const metricLabel = tContent(METRIC_LABEL_KEYS[metricParam]);
  const sortRoleLabel: Record<SortRole, string> = {
    published_at: t('sortPublishedAt'),
    d1: t('sortD1', { metric: metricLabel }),
    d7: t('sortD7', { metric: metricLabel }),
  };

  const statusFilterLabel = (status: (typeof STATUS_FILTER_OPTIONS)[number]): string => (
    status === 'unsupported' ? tContent('insightSnapshotUnsupported') : tContent(STATUS_FILTER_LABEL_KEYS[status]!)
  );

  // story #3656(유나 낱말 確定 2026-09-07) — 묶음 축 토글 라벨.
  const groupByLabel: Record<InsightsBoardGroupBy, string> = {
    none: t('groupByNone'), asset: t('groupByCreative'), hook: t('groupByHook'),
  };

  // story #3656 — 묶음 헤더의 대표 라벨. 소재=sha256 앞 8자·미태깅=「소재 없음」(신규
  // 키, 훅과 다른 말) · 훅=hook_key 그대로·미태깅=docs 네임스페이스 기존 「미분류」
  // 재사용(유나 確定 — 두 축의 미태깅 낱말이 다르다, 하나로 안 합친다).
  function groupRepresentativeLabel(mode: InsightsBoardGroupBy, rawKey: string | null): string | null {
    if (mode === 'none') return null;
    if (mode === 'asset') return rawKey ? rawKey.slice(0, ASSET_LABEL_PREFIX_LENGTH) : t('groupCreativeNone');
    return rawKey ?? tDocs('indexCategoryUncategorized');
  }

  // PO 브리프 — 이 기능 전체가 BE 기준 사람 전용(follow-up POST가 403 FOLLOW_UP_CREATE_
  // HUMAN_ONLY). 액터 종류를 미리 알 수 있으면(useDashboardContext().currentMemberType)
  // 버튼 자체를 숨긴다 — 실패로 알리는 대신 애초에 안 보여준다.
  const canCreateFollowUp = currentMemberType !== 'agent';

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('pageDescription')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground"
            data-testid="insights-board-window-trigger"
          >
            {t('windowLabel')} {t(`window${windowParam}`)}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              {WINDOW_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  onClick={() => updateQuery({ window: option === DEFAULT_WINDOW ? null : option })}
                >
                  {t(`window${option}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <input
          value={channelParam}
          onChange={(e) => updateQuery({ channel: e.target.value || null })}
          placeholder={t('channelFilterPlaceholder')}
          className="w-40 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-foreground placeholder:text-muted-foreground"
          data-testid="insights-board-channel-filter"
        />

        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground"
            data-testid="insights-board-status-trigger"
          >
            {statusParam ? statusFilterLabel(statusParam as (typeof STATUS_FILTER_OPTIONS)[number]) : t('statusFilterAll')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => updateQuery({ status: null })}>{t('statusFilterAll')}</DropdownMenuItem>
              {STATUS_FILTER_OPTIONS.map((option) => (
                <DropdownMenuItem key={option} onClick={() => updateQuery({ status: option })}>
                  {statusFilterLabel(option)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground"
            data-testid="insights-board-metric-trigger"
          >
            {t('metricLabel')} {metricLabel}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              {METRIC_KEYS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  onClick={() => updateQuery({ metric: option === DEFAULT_METRIC ? null : option })}
                >
                  {tContent(METRIC_LABEL_KEYS[option])}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground"
            data-testid="insights-board-sort-trigger"
          >
            {t('sortLabel')} {sortRoleLabel[sortRoleParam]}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              {SORT_ROLE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  onClick={() => updateQuery({ sort: option === DEFAULT_SORT_ROLE ? null : option })}
                >
                  {sortRoleLabel[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={() => updateQuery({ sort_dir: sortDirParam === 'desc' ? 'asc' : null })}
          className="inline-flex items-center gap-1 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground"
          data-testid="insights-board-sort-dir-toggle"
        >
          {sortDirParam === 'desc' ? t('sortDirDesc') : t('sortDirAsc')}
        </button>

        {/* story #3656 — 소재/훅 묶음 토글. 서버 쿼리에 안 실림(client-side groupBy). */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-center gap-1.5 rounded-[0.5rem] border border-border bg-card px-[10px] py-[7px] text-[12px] text-muted-foreground"
            data-testid="insights-board-group-by-trigger"
          >
            {t('groupByLabel')} {groupByLabel[groupByParam]}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              {GROUP_BY_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  onClick={() => updateQuery({ group_by: option === DEFAULT_GROUP_BY ? null : option })}
                >
                  {groupByLabel[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {loadErrorMessage ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{loadErrorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-3" data-testid="insights-board-loading">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : rows.length === 0 ? (
        !loadErrorMessage ? <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} /> : null
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('columnTitle')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('columnChannel')}</th>
                  {/* doc a0da40c9 §21-4(유나 권장, 값싼 것) — 정렬 드롭다운 라벨이 이미
                      글자로 「지금 무엇으로」를 말하므로 필수는 아니지만, 정렬 중인
                      열의 <th>에 aria-sort를 붙이면 보조기술이 표 안에서도 그 사실을
                      안다. 헤더 클릭 정렬은 도입하지 않는다(§21-4 명시 금지). */}
                  <th
                    className="px-3 py-2 text-left font-medium"
                    aria-sort={sortRoleParam === 'published_at' ? (sortDirParam === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {t('columnPublishedAt')}
                  </th>
                  <th
                    className="px-3 py-2 text-left font-medium"
                    aria-sort={sortRoleParam === 'd1' ? (sortDirParam === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {t('columnD1')} {metricLabel}
                  </th>
                  <th
                    className="px-3 py-2 text-left font-medium"
                    aria-sort={sortRoleParam === 'd7' ? (sortDirParam === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {t('columnD7')} {metricLabel}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">{t('columnComments')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('columnActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {groupInsightsBoardRows(rows, groupByParam).map((group) => (
                <Fragment key={group.groupKey}>
                {/* story #3656 — 묶음 헤더(groupByParam='none'이면 그룹마다 행 1개라
                    안 그린다, 기존 무회귀). 대표 라벨+구성원 수·1d/7d 합계(전부
                    captured일 때만, 아니면 대기 중 재사용 — aggregateGroupBucket). */}
                {groupByParam !== 'none' ? (
                  <tr className="bg-muted/30 text-xs" data-testid="insights-board-group-header">
                    <td colSpan={3} className="px-3 py-2 font-medium text-foreground">
                      <span data-testid="insights-board-group-label">
                        {groupRepresentativeLabel(groupByParam, group.rawKey)}
                      </span>
                      <span className="ml-2 text-muted-foreground">
                        {t('groupMemberCount', { n: group.rows.length })}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <InsightsBoardMetricCell
                        bucket={aggregateGroupBucket(group.rows, 'd1')} metric={metricParam}
                        tContent={tContent} tBoard={t}
                      />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <InsightsBoardMetricCell
                        bucket={aggregateGroupBucket(group.rows, 'd7')} metric={metricParam}
                        tContent={tContent} tBoard={t}
                      />
                    </td>
                    <td colSpan={2} />
                  </tr>
                ) : null}
                {group.rows.map((row) => {
                  const index = rows.findIndex((r) => r.publication_id === row.publication_id);
                  const reconcile = reconcileState[row.publication_id];
                  // story #3620 AC3 — 「발행 後 행에만」. hosted_site(site_post)는
                  // channel_publication이 없어 BE가 항상 INSIGHT_PUBLICATION_NOT_FOUND
                  // 를 낸다 — 버튼 자체를 그 행엔 안 보여준다(follow-up 사람전용 게이트와
                  // 동형: 실패로 알리는 대신 애초에 숨긴다).
                  const canReconcile = row.kind === 'channel_publication';
                  return (
                    <Fragment key={row.publication_id}>
                  <tr
                    ref={(el) => {
                      if (el) rowRefs.current.set(row.publication_id, el);
                      else rowRefs.current.delete(row.publication_id);
                    }}
                    data-testid="insights-board-row"
                    data-highlighted={highlightedRowId === row.publication_id ? 'true' : undefined}
                    className={highlightedRowId === row.publication_id ? 'bg-primary/10 motion-safe:transition-colors' : undefined}
                  >
                    <td className="max-w-xs truncate px-3 py-2.5 font-medium text-foreground">
                      {row.external_url ? (
                        <a href={row.external_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {row.title}
                        </a>
                      ) : (
                        row.title
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{channelLabel(row.channel, tContent)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {formatRelativeTime(row.published_at, locale, displayTimezone)}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <InsightsBoardMetricCell bucket={row.d1} metric={metricParam} tContent={tContent} tBoard={t} />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <InsightsBoardMetricCell bucket={row.d7} metric={metricParam} tContent={tContent} tBoard={t} />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground" data-testid="insights-board-comments-cell">
                      <InsightsBoardCommentsCell row={row} t={t} />
                    </td>
                    <td className="px-3 py-2.5">
                      {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「후속 조치」
                          접근 이름이라 보조기술 버튼 목록에서 어느 행인지 못 가른다. */}
                      <div className="flex flex-wrap gap-1.5">
                        {canCreateFollowUp ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setFollowUpRow(row)}
                            data-testid="insights-board-follow-up-button"
                            aria-label={t('rowActionAriaLabel', { n: index + 1, label: t('followUpAction') })}
                          >
                            {t('followUpAction')}
                          </Button>
                        ) : null}
                        {/* story #3620 AC3 — 「원본과 대조」, 진행 中 비활성. */}
                        {canReconcile ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleReconcile(row)}
                            disabled={reconcile?.status === 'loading'}
                            data-testid="insights-board-reconcile-button"
                            aria-label={t('rowActionAriaLabel', { n: index + 1, label: t('reconcileAction') })}
                          >
                            {reconcile?.status === 'loading' ? t('reconcileInProgress') : t('reconcileAction')}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {reconcile && reconcile.status !== 'loading' ? (
                    <tr data-testid="insights-board-reconcile-result-row">
                      <td colSpan={7} className="px-3 py-1.5 text-xs">
                        {reconcile.status === 'error' ? (
                          <span className="text-destructive" data-testid="insights-board-reconcile-error">
                            {reconcile.message}
                          </span>
                        ) : (
                          <ReconcileResultLine verdicts={reconcile.verdicts} />
                        )}
                      </td>
                    </tr>
                  ) : null}
                    </Fragment>
                  );
                })}
                </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void handleLoadMore()} disabled={loadingMore}>
                {loadingMore ? t('loadingMore') : t('loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {followUpRow && orgId ? (
        <FollowUpDialog
          orgId={orgId}
          publicationId={followUpRow.publication_id}
          originalTitle={followUpRow.title}
          onClose={() => setFollowUpRow(null)}
        />
      ) : null}
    </div>
  );
}
