'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { Button } from '@/components/ui/button';
import { InsightsBoardMetricCell } from './insights-board-metric-cell';
import { FollowUpDialog } from './follow-up-dialog';
import { declaredMetricsForChannel } from './channel-declared-metrics';
import { METRIC_KEYS, type BoardMetric, type InsightsBoardResponse, type InsightsBoardRow } from './types';

/**
 * story #3697(Phase2·FE, 유나 § 確定 2026-09-08) — 한 story(캠페인)의 발행물을 blog/social
 * 축으로 갈라 d1/d7을 나란히 보여주는 소비 화면. #4047(work_item_id 필터, 배포 55) 계약에
 * 대고 빌드 — org-wide 성과 보드(organization/insights-board/page.tsx)는 손대지 않는다.
 *
 * 유나 § 핵심 결정:
 * ① 배치=story 상세 패널(이 컴포넌트가 그 섹션 자체 — story-detail-panel.tsx가 storyId만
 *    주고 소비).
 * ② 레이아웃=9×4 표 기각. "매체가 선언한 지표만" 그린다(declared-metrics-for-channel.ts) —
 *    선언 안 한 지표는 행 자체를 안 그린다(대시도 0도 아님). METRIC_KEYS 순서가 views를
 *    맨 앞에 두므로 "공통 축(views) 먼저 → 매체별 나머지"가 이 순서 그대로 실현된다.
 * ③ views조차 블로그(beacon 방문자)·소셜(채널 API 조회수)이 다른 셈법이라, views 행에만
 *    출처 한 마디를 붙인다(같은 낱말이 두 세계를 덮는 유일한 자리).
 * ④ 소셜 여러 채널은 합산하지 않는다(채널마다 선언 지표가 달라 합산하면 대부분 null) —
 *    발행물(publication)마다 카드 하나.
 */

const METRIC_LABEL_KEYS: Record<BoardMetric, string> = {
  views: 'insightMetricViews',
  impressions: 'insightMetricImpressions',
  reach: 'insightMetricReach',
  engagements: 'insightMetricEngagements',
  clicks: 'insightMetricClicks',
  spend: 'insightMetricSpend',
  conversions: 'insightMetricConversions',
  inflow_sessions: 'insightMetricInflowSessions',
  inflow_users: 'insightMetricInflowUsers',
};

function isBlogRow(row: InsightsBoardRow): boolean {
  return row.kind === 'site_post';
}

function PublicationCard({
  row, orgId, tBoard, tContent,
}: {
  row: InsightsBoardRow;
  orgId: string;
  tBoard: ReturnType<typeof useTranslations>;
  tContent: ReturnType<typeof useTranslations>;
}) {
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const declared = declaredMetricsForChannel(row.channel);
  const orderedMetrics = METRIC_KEYS.filter((m) => declared.includes(m));
  const sourceLabelKey = isBlogRow(row) ? 'storyCompareSourceSiteBeacon' : 'storyCompareSourceChannelApi';

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2" data-testid="story-compare-publication-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {row.external_url ? (
            <a href={row.external_url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-foreground hover:underline">
              {row.title}
            </a>
          ) : (
            <p className="text-sm font-medium text-foreground">{row.title}</p>
          )}
          <p className="text-xs text-muted-foreground">{channelLabel(row.channel, tContent)}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setFollowUpOpen(true)} data-testid="story-compare-follow-up-button">
          {tBoard('followUpAction')}
        </Button>
      </div>

      {orderedMetrics.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tContent('insightMetricUnavailableReason')}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-1/2 pb-1 font-normal" />
              <th className="pb-1 font-normal">{tBoard('columnD1')}</th>
              <th className="pb-1 font-normal">{tBoard('columnD7')}</th>
            </tr>
          </thead>
          <tbody>
            {orderedMetrics.map((metric) => (
              <tr key={metric} className="border-t border-border/60">
                <td className="py-1 pr-2 text-foreground">
                  {tContent(METRIC_LABEL_KEYS[metric])}
                  {metric === 'views' ? (
                    <span className="ml-1 text-[11px] text-muted-foreground">({tBoard(sourceLabelKey)})</span>
                  ) : null}
                </td>
                <td className="py-1"><InsightsBoardMetricCell bucket={row.d1} metric={metric} tContent={tContent} tBoard={tBoard} /></td>
                <td className="py-1"><InsightsBoardMetricCell bucket={row.d7} metric={metric} tContent={tContent} tBoard={tBoard} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {followUpOpen ? (
        <FollowUpDialog
          orgId={orgId}
          publicationId={row.publication_id}
          originalTitle={row.title}
          onClose={() => setFollowUpOpen(false)}
        />
      ) : null}
    </div>
  );
}

function AxisGroup({
  titleKey, rows, orgId, tBoard, tContent,
}: {
  titleKey: string;
  rows: InsightsBoardRow[];
  orgId: string;
  tBoard: ReturnType<typeof useTranslations>;
  tContent: ReturnType<typeof useTranslations>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{tBoard(titleKey)}</p>
      <div className="space-y-2">
        {rows.map((row) => (
          <PublicationCard key={row.publication_id} row={row} orgId={orgId} tBoard={tBoard} tContent={tContent} />
        ))}
      </div>
    </div>
  );
}

export interface StoryInsightsCompareSectionProps {
  storyId: string;
}

export function StoryInsightsCompareSection({ storyId }: StoryInsightsCompareSectionProps) {
  const { orgId } = useDashboardContext();
  const tBoard = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  const [rows, setRows] = useState<InsightsBoardRow[] | null>(null);
  // story #3697(유나 § ②) — has_more는 kind별 상한(BE)에 잘린 게 있는지만 말한다(몇 건인지는
  // 모른다 — 수를 지어내지 않는다). 섹션 수준 한 줄로만 쓴다(어느 축이 잘렸는지는 has_more가
  // 말 안 해서 특정 축 밑에 붙이면 모르는 것을 단정하게 된다).
  const [hasMore, setHasMore] = useState(false);

  // MeasuredMetricsCards와 동형 패턴(인라인 IIFE — 별도 useCallback으로 안 뺀다).
  useEffect(() => {
    if (!orgId || !storyId) return;
    let cancelled = false;
    void (async () => {
      try {
        // AC1 — #4047 work_item_id 필터. window는 이 화면이 항상 명시(page.tsx의 window
        // 관례 그대로) — story 범위로 이미 좁혔으니 가장 넓은 90d로 고정해 놓치는 행이
        // 없게 한다.
        const qs = new URLSearchParams({ work_item_id: storyId, window: '90d' });
        const res = await fetchWithAuth(`/api/organizations/${orgId}/insights-board?${qs.toString()}`);
        if (cancelled) return;
        if (!res.ok) {
          // story-detail-panel의 ArtifactSection 관례(404·에러→무표시) 재사용 — 이 섹션은
          // "있으면 보여주는" 부가 정보라 에러를 화면 전체에 드러내지 않는다.
          setRows([]);
          return;
        }
        const json = (await res.json().catch(() => null)) as { data?: InsightsBoardResponse } | null;
        if (cancelled) return;
        setRows(json?.data?.rows ?? []);
        setHasMore(json?.data?.has_more ?? false);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, storyId]);

  if (!orgId || !rows || rows.length === 0) return null;

  const blogRows = rows.filter(isBlogRow);
  const socialRows = rows.filter((r) => !isBlogRow(r));

  return (
    <div className="space-y-3" data-testid="story-insights-compare-section">
      <p className="text-xs font-medium text-muted-foreground">{tBoard('storyCompareTitle')}</p>
      {hasMore ? (
        <p className="text-xs text-muted-foreground" data-testid="story-compare-partial-notice">
          {tBoard('storyComparePartialNotice')}
        </p>
      ) : null}
      <AxisGroup titleKey="storyCompareAxisBlog" rows={blogRows} orgId={orgId} tBoard={tBoard} tContent={tContent} />
      <AxisGroup titleKey="storyCompareAxisSocial" rows={socialRows} orgId={orgId} tBoard={tBoard} tContent={tContent} />
    </div>
  );
}
