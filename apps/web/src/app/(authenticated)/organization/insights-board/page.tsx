'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { parseInsightsBoardApiError } from '@/components/insights-board/insights-board-error';
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

export default function InsightsBoardPage() {
  const { orgId, currentMemberType } = useDashboardContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;

  const windowParam = (searchParams.get('window') as InsightsBoardWindow | null) ?? DEFAULT_WINDOW;
  const channelParam = searchParams.get('channel') ?? '';
  const statusParam = searchParams.get('status') ?? '';
  const sortRoleParam = (searchParams.get('sort') as SortRole | null) ?? DEFAULT_SORT_ROLE;
  const sortDirParam = (searchParams.get('sort_dir') as SortDir | null) ?? DEFAULT_SORT_DIR;
  const rawMetricParam = searchParams.get('metric') as BoardMetric | null;
  const metricParam: BoardMetric = rawMetricParam && METRIC_KEYS.includes(rawMetricParam) ? rawMetricParam : DEFAULT_METRIC;
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
                {rows.map((row) => (
                  <tr key={row.publication_id} data-testid="insights-board-row">
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
                      {canCreateFollowUp ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setFollowUpRow(row)}
                          data-testid="insights-board-follow-up-button"
                        >
                          {t('followUpAction')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
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
