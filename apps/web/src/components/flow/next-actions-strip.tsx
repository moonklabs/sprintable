'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { GoalStem, NextMakerStory } from './derive-next-maker';
import { GoalStemCard, type MemberLite } from './goal-stem-card';
import { StemRow } from './stem-row';

interface NextActionsStripProps {
  /** deriveGoalStems가 만든 것 중 hasNext=false만, sortStemsByStallUrgency로 정렬된 채로. */
  needsNextStems: GoalStem[];
  quietCount: number;
  projectId: string;
  backlogByEpic: Map<string, NextMakerStory[]>;
  recentlyClosedTargetIds: Set<string>;
  memberMap: Record<string, MemberLite>;
  onSelectStory: (storyId: string) => void;
  onStoryPromoted: (storyId: string, epicId: string) => void;
  onPromoteFailed: (storyId: string) => void;
  onGoalTransitioned: (epicId: string) => void;
}

/**
 * story #2224 AC1 후속(2026-07-31, PO 정정 — 「«수단»(픽 패널)을 빼면 그 위에 탄 «다른
 * 목적»(승격·전환)이 같이 죽는다」) — 목표 하나를 고르는 픽 패널 자체는 멀티레인 캔버스가
 * 대체했지만, 그 패널이 실어 나르던 «동사 둘»(백로그 스토리를 다음으로 승격 / 조용한 목표를
 * 닫거나 보관)은 다른 곳으로 옮겨야 사라지지 않는다(고아 배정은 OrphanStoriesPanel에 이미
 * 살아 있어 여기 없다). 행은 접힌 채가 기본 — 펼치면 그 목표의 GoalStemCard를
 * showCanvas=false로 인라인에 붙인다(캔버스는 안 그린다, 몸통은 아래 FlowMultiLaneCanvas).
 */
export function NextActionsStrip({
  needsNextStems, quietCount, projectId, backlogByEpic, recentlyClosedTargetIds, memberMap,
  onSelectStory, onStoryPromoted, onPromoteFailed, onGoalTransitioned,
}: NextActionsStripProps) {
  const t = useTranslations('flow');
  const [expandedEpicId, setExpandedEpicId] = useState<string | null>(null);

  if (needsNextStems.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {t('nextMakerNeedsNextHeading', { n: needsNextStems.length })}
      </p>
      {needsNextStems.map((stem, i) => {
        // 정렬이 이미 about-to-stall → recently-active → quiet 순이라 quiet는 항상 꼬리의
        // 연속 구간 — 그 구간이 시작되는 지점에만 힌트 한 줄을 붙인다.
        const showQuietHint = stem.priority === 'quiet'
          && (i === 0 || needsNextStems[i - 1].priority !== 'quiet');
        const isExpanded = stem.epicId === expandedEpicId;
        return (
          <div key={stem.epicId}>
            {showQuietHint && (
              <p className="mb-1 mt-2 text-[10px] text-muted-foreground">
                {t('nextMakerQuietHint', { n: quietCount })}
              </p>
            )}
            <StemRow
              stem={stem}
              isExpanded={isExpanded}
              onToggle={() => setExpandedEpicId(isExpanded ? null : stem.epicId)}
            />
            {isExpanded && (
              <div className="mt-1.5 rounded-lg border border-border bg-muted/20 p-2.5">
                <GoalStemCard
                  key={stem.epicId}
                  stem={stem}
                  projectId={projectId}
                  backlogStories={backlogByEpic.get(stem.epicId) ?? []}
                  recentlyClosedTargetIds={recentlyClosedTargetIds}
                  memberMap={memberMap}
                  onSelectStory={onSelectStory}
                  onStoryPromoted={onStoryPromoted}
                  onPromoteFailed={onPromoteFailed}
                  onGoalTransitioned={onGoalTransitioned}
                  showCanvas={false}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
