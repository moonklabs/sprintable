'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COLUMNS, type KanbanStory, type KanbanMember, type LineStatusSummary } from './types';
import { StoryCard } from './story-card';
import type { LabelData } from '@/components/ui/label-chip';
import { CountBadge } from '@/components/ui/count-badge';

interface KanbanListViewProps {
  stories: KanbanStory[];
  epicMap: Record<string, string>;
  memberMap: Record<string, KanbanMember>;
  onStoryClick: (story: KanbanStory) => void;
  onChangeStatus: (storyId: string, newStatus: string) => Promise<void>;
  // story #3043(PO+유나 IA 확定 ⓒ, 2026-08-25) — 이 뷰의 행 atom을 자체 마크업(ListStoryRow)
  // 대신 SID 3018 보드 카드(StoryCard)로 교체하면서 board 뷰(KanbanColumn)와 동일한 부가
  // 데이터가 필요해졌다. 전부 optional(map에 키 없으면 story-card.tsx 자체 기본값으로
  // 후퇴 — 카드 쪽이 이미 그 후퇴를 규율하므로 여기서 재구현하지 않는다).
  executionMap?: Record<string, { status: string; rule_name?: string | null; completed_at?: string | null }>;
  blockedByMap?: Record<string, string[]>;
  storyLabelsMap?: Record<string, LabelData[]>;
  storyGatesMap?: Record<string, { id: string; gate_type: string; status: string }[]>;
  storyLineMap?: Record<string, LineStatusSummary>;
  projectId?: string;
  /** story #3287 AC4 — org 라벨 오버라이드(useOrgDomainLabels().statusLabel). 없으면
   * 기존 t(col.i18nKey) 그대로(회귀 0). 그룹 헤더+카드 내부 배지 둘 다에 쓰인다. */
  getStatusLabel?: (canonicalSlug: string) => string | undefined;
}

interface StatusGroupProps {
  columnId: string;
  label: string;
  stories: KanbanStory[];
  epicMap: Record<string, string>;
  memberMap: Record<string, KanbanMember>;
  onStoryClick: (story: KanbanStory) => void;
  onChangeStatus: (storyId: string, newStatus: string) => Promise<void>;
  executionMap?: KanbanListViewProps['executionMap'];
  blockedByMap?: KanbanListViewProps['blockedByMap'];
  storyLabelsMap?: KanbanListViewProps['storyLabelsMap'];
  storyGatesMap?: KanbanListViewProps['storyGatesMap'];
  storyLineMap?: KanbanListViewProps['storyLineMap'];
  projectId?: string;
  getStatusLabel?: KanbanListViewProps['getStatusLabel'];
}

function StatusGroup({
  columnId, label, stories, epicMap, memberMap, onStoryClick, onChangeStatus,
  executionMap, blockedByMap, storyLabelsMap, storyGatesMap, storyLineMap, projectId, getStatusLabel,
}: StatusGroupProps) {
  const [expanded, setExpanded] = useState(columnId !== 'done');

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm font-semibold text-foreground hover:bg-muted/50"
        onClick={() => setExpanded((p) => !p)}
      >
        {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        {/* 유나 design:changes(PR#3687, 2026-09-01) — kanban-column.tsx L169과 동일 구조
            (label→CountBadge 밀어내기 위험). min-w-0+truncate로 긴 org 라벨을 흡수,
            title로 전체 문구 확인. */}
        <span className="min-w-0 truncate" title={label}>{label}</span>
        {/* story #3050(2984-S2, 유나 design PASS 비차단 finding) — CountBadge(S1) 채택,
            bg-muted 채움 폐지. */}
        <CountBadge count={stories.length} className="ml-auto shrink-0" />
      </button>

      {expanded && (
        <div className={cn('mt-1 space-y-2 pl-2', stories.length === 0 && 'pb-2')}>
          {stories.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">—</p>
          ) : (
            // story #3043 AC ⓒ — <lg 단일열은 컬럼을 가로로 두지 않는다(status는 이 섹션
            // 그룹 헤더가 이미 표현). full-width(w-full)만 얹고 카드 재질 자체는 board 뷰와
            // 완전히 동일한 StoryCard를 재사용(kanban-column.tsx의 호출부와 동형).
            stories.map((story) => (
              <div key={story.id} className="w-full">
                <StoryCard
                  className="max-w-none"
                  story={story}
                  epicName={story.epic_id ? epicMap[story.epic_id] : undefined}
                  assignee={story.assignee_id ? memberMap[story.assignee_id] : undefined}
                  assignees={(story.assignee_ids ?? []).flatMap((id) => (memberMap[id] ? [memberMap[id]] : []))}
                  onClick={() => onStoryClick(story)}
                  onChangeStatus={(storyId, newStatus) => void onChangeStatus(storyId, newStatus)}
                  projectId={projectId}
                  lastExecution={executionMap?.[story.id] ?? null}
                  blockedBy={blockedByMap?.[story.id] ?? []}
                  labels={storyLabelsMap?.[story.id] ?? []}
                  gates={storyGatesMap?.[story.id] ?? []}
                  lineStatus={storyLineMap?.[story.id]}
                  verifiedBy={story.human_verified_by ? memberMap[story.human_verified_by] : undefined}
                  getStatusLabel={getStatusLabel}
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function KanbanListView({
  stories, epicMap, memberMap, onStoryClick, onChangeStatus,
  executionMap, blockedByMap, storyLabelsMap, storyGatesMap, storyLineMap, projectId, getStatusLabel,
}: KanbanListViewProps) {
  const t = useTranslations('board');

  return (
    <div className="space-y-2">
      {COLUMNS.map((col) => {
        const colStories = stories.filter((s) => s.status === col.id);
        return (
          <StatusGroup
            key={col.id}
            columnId={col.id}
            label={getStatusLabel?.(col.id) ?? t(col.i18nKey)}
            stories={colStories}
            epicMap={epicMap}
            memberMap={memberMap}
            onStoryClick={onStoryClick}
            onChangeStatus={onChangeStatus}
            executionMap={executionMap}
            blockedByMap={blockedByMap}
            storyLabelsMap={storyLabelsMap}
            storyGatesMap={storyGatesMap}
            storyLineMap={storyLineMap}
            projectId={projectId}
            getStatusLabel={getStatusLabel}
          />
        );
      })}
    </div>
  );
}
