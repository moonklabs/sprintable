'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';
import { InsightsBoardMetricCell } from '@/components/insights-board/insights-board-metric-cell';
import { AdsSpendCell } from '@/components/insights-board/ads-spend-cell';
import { InsightsBoardCommentsCell } from '@/components/insights-board/insights-board-comments-cell';
import { FollowUpDialog } from '@/components/insights-board/follow-up-dialog';
import { ReconcileResultLine } from '@/components/insights-board/reconcile-result-line';
import { parseInsightsBoardApiError } from '@/components/insights-board/insights-board-error';
import { ASSET_LABEL_PREFIX_LENGTH, aggregateGroupBucket, groupInsightsBoardRows, type InsightsBoardGroupBy } from '@/components/insights-board/group-rows';
import { DEFAULT_METRIC, METRIC_KEYS, type BoardMetric, type Ga4ConnectionStatus, type InsightsBoardResponse, type InsightsBoardRow, type InsightsBoardWindow } from '@/components/insights-board/types';
import { PublishingMetricsBand } from '@/components/content/publishing-metrics-band';
import { OrgCostSummaryCard } from '@/components/insights-board/org-cost-summary-card';
import { PaidSpendDailySeriesCard } from '@/components/insights-board/paid-spend-daily-series-card';
import { deriveFailureAction, type CommandStatus } from '@/components/content/failure-action';
import { FailureActionBadge } from '@/components/content/failure-action-badge';

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
// story #3746(유나 v5, 2026-09-09) — 출처는 `InsightSnapshot.status`(BE)다, FE가
// 지어내는 옵션이 아니다. 첫 판(v3)이 FE 상수에서 옵션을 뽑아 유령(`dead_letter`,
// BE 서비스 전수 0건 — #3720/#3721이 걷은 것과 같은 클래스)을 넣고 실사용 둘
// (`in_progress`·`superseded`)을 빠뜨렸다. 정정 — 통 넷: `pending`(BE로 보낼 때
// `in_progress`도 같이 묶인다, 서버가 그 값을 안다 — 아래 statusFilterLabel 참조)·
// `captured`·`unsupported`·`failed`. `superseded`는 옵션이 아니라 BE 기본 배제
// (insights_board.py 참조, "화면 넷이 같은 목록을 부르는데 화면마다 거르면 갈린다").
const STATUS_FILTER_OPTIONS = ['pending', 'captured', 'unsupported', 'failed'] as const;
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
// 네임스페이스 기존 키를 그대로 재사용한다(pending은 이 맵에 없다 — 아래
// statusFilterLabel에서 별도 분기, insightsBoard 전용 낱말이라 다른 네임스페이스).
// story #3746(PO CHANGES①②, 2026-09-09) — 이 맵도 셀·block에서 걷은 바로 그
// `Partial<Record>`+`!` 클래스였다(옵션 하나가 빠져도 tsc가 안 막던 자리) —
// `Record`(비-Partial, pending 제외)로 바꿔 captured/failed/unsupported 셋
// 전부 채운다. unsupported는 문장(insightSnapshotUnsupported, 상세 블록 전용)
// 대신 셀과 같은 명사구(insightStatusUnsupported)로 통일 — 한 통엔 한 낱말.
const STATUS_FILTER_LABEL_KEYS: Record<Exclude<(typeof STATUS_FILTER_OPTIONS)[number], 'pending'>, string> = {
  captured: 'insightStatusCaptured',
  unsupported: 'insightStatusUnsupported',
  failed: 'insightStatusFailed',
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
  const locale = useLocale();
  const tContent = useTranslations('content');
  // story #3583(정정, 2026-09-10) — GA4 유입 지표 null 사유의 needs_reauth 갈래가
  // 채널 연결 화면 기존 낱말을 재사용한다(새 낱말 0, PO 確定).
  const tChannelConnect = useTranslations('channelConnect');
  // story #3656 — 훅 미태깅 묶음 라벨은 새 낱말을 안 만들고 docs 네임스페이스 기존
  // 키(indexCategoryUncategorized, 「미분류」)를 재사용한다(유나 確定).
  const tDocs = useTranslations('docs');
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
  // story #3746(3734 AC3 잔존 A) — 목록 두 화면(content/page.tsx·channel-posts/
  // page.tsx)과 같은 낱말·같은 파라미터명(「보관됨 보기」·include_deleted=true).
  // 기본 false(보관된 원 초안의 발행분은 기본 제외 — #4087).
  const [showArchived, setShowArchived] = useState(false);
  // story #3746(3734 §4-C) — 초안 1개 보관이 언어별 발행 행 N개를 한꺼번에 숨길 수
  // 있다(work_item_id 기준 join, lang은 그 유니크 밖 — site_post.py:20). BE가 그
  // 숨은 수를 셀 수 있을 때만 보낸다(모르면 null — 지어내지 않는다).
  const [hiddenCount, setHiddenCount] = useState<number | null>(null);
  // story #3583(2026-09-10) — org당 1값(응답 전체에 실림, 행마다가 아니다). 기본값
  // not_connected는 「아직 안 왔다」 쪽으로 낙관하지 않는다(로딩 中 GA4 셀이 우연히
  // "집계 대기"를 보이는 것보다 "미연결"이 더 안전한 기본 — 실응답이 곧 덮는다).
  const [ga4ConnectionStatus, setGa4ConnectionStatus] = useState<Ga4ConnectionStatus>('not_connected');
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
    if (showArchived) qs.set('include_deleted', 'true');
    if (cursor) qs.set('cursor', cursor);
    return qs.toString();
  }, [windowParam, channelParam, statusParam, resolvedSort, sortDirParam, showArchived]);

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
        setHiddenCount(json?.data?.hidden_count ?? null);
        setGa4ConnectionStatus(json?.data?.ga4_connection_status ?? 'not_connected');
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

  // story #3746(유나 v5) — pending은 이제 「수집 대기」 한 통(BE로는 pending+in_progress
  // 둘 다 이 값으로 보낸다, buildQuery의 status 파라미터 참조) — 이 통 전용 신규 낱말
  // (insightsBoard.statusFilterPending)이라 content 네임스페이스 기존 「대기 중」과
  // 다른 자리(그 키는 다른 화면이 계속 쓴다, 값 두 벌 아님 — 통 자체가 다르다).
  const statusFilterLabel = (status: (typeof STATUS_FILTER_OPTIONS)[number]): string => {
    if (status === 'pending') return t('statusFilterPending');
    return tContent(STATUS_FILTER_LABEL_KEYS[status]);
  };

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

  // story #3746(①③ 개정, page-header.tsx 규율 — "화면마다 주 액션 1개를 제목 줄
  // 오른쪽에") — 이 화면의 다음 발은 「읽는다」라 텍스트 버튼류 주 액션은 없다(시안
  // v4). 그래도 기간 컨트롤은 이 화면 자체를 규정하는 값이라(§5 — 띠도 이 값을
  // 따른다) 제목 줄 우측에 둔다 — «주 액션 자리»를 그 컨트롤이 채운다.
  const windowControl = (
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
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} actions={windowControl} />

      {/* story #3809(Phase3·3-7 PR 3) — 조직 비용 원장 카드. window/channel/status
          필터와 무관한 org 전체 스코프(cost-summary API는 쿼리 파라미터가 없다) —
          아래 표 필터 줄보다 위, 화면의 다른 무엇에도 종속되지 않는 자리. */}
      {orgId ? <OrgCostSummaryCard orgId={orgId} /> : null}
      {/* story #3809(Phase3·3-7 PR 4b) — 일별 paid 지출 시계열. 요약 카드 바로
          아래, 같은 org 전체 스코프(쿼리 파라미터 무관)라 필터 줄보다 위. */}
      {orgId ? <PaidSpendDailySeriesCard orgId={orgId} /> : null}

      <div className="flex flex-wrap items-center gap-2">
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

      {/* story #3746(3734 AC3 잔존 A) — 목록 두 화면과 같은 낱말·같은 뜻(`content.
          showArchivedToggle`/`hideArchivedToggle` 재사용, 값 두 벌 안 만든다). 숨은
          건수는 셀 수 있을 때만(hiddenCount null이면 안 그린다 — 모른다≠0). */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button" variant="link"
          onClick={() => setShowArchived((v) => !v)}
          className="h-auto min-h-0 min-w-0 px-0 text-sm font-normal text-foreground underline"
          data-testid="insights-board-show-archived-toggle"
        >
          {showArchived ? tContent('hideArchivedToggle') : tContent('showArchivedToggle')}
        </Button>
        {!showArchived && hiddenCount !== null && hiddenCount > 0 ? (
          <span className="text-xs text-muted-foreground" data-testid="insights-board-hidden-count">
            {t('archivedHiddenCount', { count: hiddenCount })}
          </span>
        ) : null}
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
        !loadErrorMessage ? (
          // story #3746(3734 AC3 잔존 A, 유나 定) — 「선택한 조건에 해당하는 발행 글이
          // 아직 없습니다」는 사용자가 조건을 고른 적 없을 때(보관됨 보기를 안 켰는데
          // 빈 화면) 틀린 말이다. 보관 때문에 비어 있는 갈래를 따로 가른다 — showArchived
          // =false인데 hiddenCount>0이면 "지금 안 보이는 건 있는데 필터가 그걸 뺐다"는
          // 뜻이라 그 자체가 답(보관된 것만 있다는 확定은 아니지만, 적어도 "조건" 탓으로
          // 잘못 말하지 않는다).
          !showArchived && hiddenCount !== null && hiddenCount > 0 ? (
            <EmptyState title={t('emptyTitle')} description={t('archivedEmptyReason')} />
          ) : (
            <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
          )
        ) : null
      ) : (
        <>
          <Card className="overflow-hidden p-0">
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
                  {/* story #3806(Phase3·3-2 PR5 조각⑥, 유나 §절 §3) — 「광고비」 분리 칸.
                      정렬 대상 아님(§3에 정렬 언급 0 — d1/d7 정렬 축과 별개 개념, 헤더
                      클릭 정렬은 애초 이 화면 전체에서 금지·§21-4). */}
                  <th className="px-3 py-2 text-left font-medium">{t('columnAdsSpend')}</th>
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
                        tContent={tContent} tBoard={t} tChannelConnect={tChannelConnect}
                        ga4ConnectionStatus={ga4ConnectionStatus}
                      />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <InsightsBoardMetricCell
                        bucket={aggregateGroupBucket(group.rows, 'd7')} metric={metricParam}
                        tContent={tContent} tBoard={t} tChannelConnect={tChannelConnect}
                        ga4ConnectionStatus={ga4ConnectionStatus}
                      />
                    </td>
                    <td colSpan={3} />
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
                  // story #3766(별건 ⑩, 3746 §3 유나 定) — 「사람 차례」 발행 명령 축은
                  // 필터가 아니라 행 배지로만 선다. deriveFailureAction(단일 판정
                  // 출처, failure-action.ts)을 그대로 재사용하되 이 배지는 command
                  // Status 하나만 먹인다(failure_kind/next_retry_at/reason_code는
                  // 이 보드에 안 실려 있다 — voided/needs_check/auto_retry/processing
                  // 은 그 필드들이 있어야 판정되므로 여기선 애초에 안 뜬다). dead_letter·
                  // blocked 둘만 그 판정에 필요한 입력이 commandStatus 하나뿐이라
                  // 이 좁은 조인으로도 정확히 그 둘만 걸린다.
                  const rowFailureAction = deriveFailureAction({ commandStatus: row.command_status as CommandStatus | null });
                  const showFailureBadge = rowFailureAction?.kind === 'dead_letter' || rowFailureAction?.kind === 'blocked';
                  const hasRowActions = canCreateFollowUp || canReconcile;
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
                    {/* story #3746(유나 픽셀 PASS 곁들임, 2026-09-09) — 「발행」 칸은
                        merge-base부터 상대 시각(formatRelativeTime)이었다. 이 화면
                        정정 판에서 같이 잡는다: 「그저께」류가 서로 다른 날을 겹쳐
                        가리고(정렬 축인데 눈으로 안 보임)·d1/d7 앵커 기준인데 ±12h가
                        뭉개지고·7일이 지나면 절대 표기로 넘어가 30d/90d 기간에선
                        한 열에 상대·절대 표기가 섞인다. `formatScheduledAt(...)
                        .display`(절대 날짜)로 고정 — 이 화면의 다른 절대-시각
                        칸(computed_at 등)과도 형이 맞는다. */}
                    <td className="px-3 py-2.5 text-muted-foreground" data-testid="insights-board-published-at">
                      {formatScheduledAt(row.published_at, displayTimezone).display}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <InsightsBoardMetricCell
                        bucket={row.d1} metric={metricParam} tContent={tContent} tBoard={t}
                        tChannelConnect={tChannelConnect} ga4ConnectionStatus={ga4ConnectionStatus}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <InsightsBoardMetricCell
                        bucket={row.d7} metric={metricParam} tContent={tContent} tBoard={t}
                        tChannelConnect={tChannelConnect} ga4ConnectionStatus={ga4ConnectionStatus}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground" data-testid="insights-board-comments-cell">
                      <InsightsBoardCommentsCell row={row} t={t} />
                    </td>
                    <td className="px-3 py-2.5" data-testid="insights-board-ads-spend-cell">
                      <AdsSpendCell adsBoost={row.ads_boost} tBoard={t} tContent={tContent} locale={locale} />
                    </td>
                    <td className="px-3 py-2.5">
                      {/* story #3766(별건 ⑩, 유나 定 — issuecomment 2026-09-10 02:11Z)
                          — 상태 딱지(FailureActionBadge)는 행동 자리(아래 버튼 div)와
                          다른 자리를 쓴다: 행동칸에 섞으면 「자리가 뜻을 바꾼다」(PR#4107
                          별건 ㉓과 동형 클래스 — 소유자 배지가 제거 열에 얹혀 세로로
                          「소유자/제거/제거」로 읽히던 결함). 물음(왜 막혔나)이 생긴
                          자리에 답이 있도록 배지가 버튼 줄 «위». 배지 없으면 그 줄
                          노드 자체가 없다(①, 빈 줄이 gap만 먹지 않게). */}
                      {showFailureBadge && rowFailureAction ? (
                        <div className="mb-1.5 leading-tight">
                          <FailureActionBadge action={rowFailureAction} displayTimezone={displayTimezone} compact />
                        </div>
                      ) : null}
                      {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「후속 조치」
                          접근 이름이라 보조기술 버튼 목록에서 어느 행인지 못 가른다.
                          story #3766 — 버튼 div도 조건부(②, canCreateFollowUp·
                          canReconcile 둘 다 false면 빈 flex div 자체를 안 남긴다 —
                          배지가 뜬 행에서 그 빈 자리가 특히 눈에 띄는 걸 막는다). */}
                      {hasRowActions ? (
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
                      ) : null}
                    </td>
                  </tr>
                  {reconcile && reconcile.status !== 'loading' ? (
                    <tr data-testid="insights-board-reconcile-result-row">
                      <td colSpan={8} className="px-3 py-1.5 text-xs">
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
          </Card>

          {hasMore ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void handleLoadMore()} disabled={loadingMore}>
                {loadingMore ? t('loadingMore') : t('loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {/* story #3746(#3484 이주) — 채널 목록(content/channel-posts/page.tsx)에서
          걷고 표 아래로. 발행 품질 셋만(정시율·중복·승인 없는 호출) — 연결 건강
          (만료·7일 내 만료)은 ③(3743) 행 칩+cron 알림이 맡아 은퇴. 띠 자체 기간
          컨트롤은 없다 — 이 화면의 windowParam을 그대로 따른다(7d/30d/90d 그대로,
          띠가 자기 상태를 따로 안 갖는다). */}
      {orgId ? <PublishingMetricsBand orgId={orgId} window={windowParam} /> : null}

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
