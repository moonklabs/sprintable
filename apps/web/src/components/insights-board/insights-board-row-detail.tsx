'use client';

import type { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InsightsBoardMetricCell } from './insights-board-metric-cell';
import { AdsSpendCell } from './ads-spend-cell';
import { InsightsBoardCommentsCell } from './insights-board-comments-cell';
import type { Ga4ConnectionStatus, InsightsBoardRow } from './types';

/**
 * story #3979(자리 옮김 ①, 유나 diff doc «v3 자리») — 채널 행 펼침. 표의 D1/D7
 * 열은 지표 선택기(metricParam)에 종속돼 한 번에 한 지표만 보인다 — 이 패널은
 * «조회»(자연, views 고정) 시간축을 선택과 무관하게 항상 보여 유입원(자연)+
 * 시간축(D+1/D+7) 둘 다를 한 자리에 묶는다. 광고 축은 ads_boost(지출/잔여)뿐 —
 * AdsBoostSummaryView엔 «광고 조회» 수 자체가 없다(3977 그라운딩 §3 확認, 새
 * BE 0 원칙상 지어내지 않는다) — 기존 AdsSpendCell 그대로 재사용.
 *
 * story #3979 CHANGES(페드루 PO 2026-09-17 01:14Z) — AC③(댓글·후속 조치·원본과
 * 대조)이 아직 표 안에 있어 8→9열로 오히려 넓어졌던 결함 처방. 이 셋을 진짜로
 * 여기로 옮긴다(page.tsx 쪽 플랫 열/버튼 제거) — 컴포넌트(InsightsBoardCommentsCell·
 * Button 그대로)와 testid(insights-board-comments-cell·-follow-up-button·
 * -reconcile-button)는 무수정, 위치만 이동(기존 테스트는 "행 펼친 뒤 찾기"로
 * selector 범위만 바뀐다).
 */
export interface InsightsBoardRowDetailProps {
  row: InsightsBoardRow;
  tBoard: ReturnType<typeof useTranslations>;
  tContent: ReturnType<typeof useTranslations>;
  tChannelConnect: ReturnType<typeof useTranslations>;
  ga4ConnectionStatus: Ga4ConnectionStatus;
  locale: string;
  rowIndex: number;
  canCreateFollowUp: boolean;
  canReconcile: boolean;
  onFollowUp: () => void;
  onReconcile: () => void;
  reconcileLoading: boolean;
}

export function InsightsBoardRowDetail({
  row, tBoard, tContent, tChannelConnect, ga4ConnectionStatus, locale,
  rowIndex, canCreateFollowUp, canReconcile, onFollowUp, onReconcile, reconcileLoading,
}: InsightsBoardRowDetailProps) {
  const hasRowActions = canCreateFollowUp || canReconcile;
  return (
    <div className="space-y-3" data-testid="insights-board-row-detail">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-muted-foreground">{tBoard('rowDetailOrganicViewsLabel')}</p>
          <div className="flex flex-wrap gap-3">
            <span data-testid="insights-board-row-detail-d1">
              <span className="mr-1 text-muted-foreground">{tBoard('columnD1')}</span>
              <InsightsBoardMetricCell
                bucket={row.d1} metric="views" tContent={tContent} tBoard={tBoard}
                tChannelConnect={tChannelConnect} ga4ConnectionStatus={ga4ConnectionStatus}
              />
            </span>
            <span data-testid="insights-board-row-detail-d7">
              <span className="mr-1 text-muted-foreground">{tBoard('columnD7')}</span>
              <InsightsBoardMetricCell
                bucket={row.d7} metric="views" tContent={tContent} tBoard={tBoard}
                tChannelConnect={tChannelConnect} ga4ConnectionStatus={ga4ConnectionStatus}
              />
            </span>
          </div>
        </div>
        <div>
          <p className="mb-1 text-muted-foreground">{tBoard('rowDetailAdsSpendLabel')}</p>
          <AdsSpendCell adsBoost={row.ads_boost} tBoard={tBoard} tContent={tContent} locale={locale} />
        </div>
      </div>

      <div>
        <p className="mb-1 text-muted-foreground">{tBoard('columnComments')}</p>
        <div data-testid="insights-board-comments-cell">
          <InsightsBoardCommentsCell row={row} t={tBoard} />
        </div>
      </div>

      {hasRowActions ? (
        <div className="flex flex-wrap gap-1.5">
          {canCreateFollowUp ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onFollowUp}
              data-testid="insights-board-follow-up-button"
              aria-label={tBoard('rowActionAriaLabel', { n: rowIndex + 1, label: tBoard('followUpAction') })}
            >
              {tBoard('followUpAction')}
            </Button>
          ) : null}
          {canReconcile ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onReconcile}
              disabled={reconcileLoading}
              data-testid="insights-board-reconcile-button"
              aria-label={tBoard('rowActionAriaLabel', { n: rowIndex + 1, label: tBoard('reconcileAction') })}
            >
              {reconcileLoading ? tBoard('reconcileInProgress') : tBoard('reconcileAction')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
