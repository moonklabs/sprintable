'use client';

import type { ComponentType } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { StoryCard } from './story-card';
import type { KanbanStory, KanbanMember, LineStatusSummary, TrustColumnId } from './types';

type SortableContextCompatProps = {
  children?: React.ReactNode;
  items: readonly unknown[];
  strategy: unknown;
  disabled?: boolean;
};
const SortableContextCompat = SortableContext as unknown as ComponentType<SortableContextCompatProps>;

// story #2933 H4(P0-H, v4 아티팩트 e65f1016 §B) — 대시보드/legend 색. 기존 STATUS_COLOR
// (kanban-column.tsx)와 동형 규율(신규 raw 팔레트 0, 기존 시맨틱 토큰만) — grey=중립·
// info(=proof-blue 별칭, globals.css)=진행형·warning=주의(파생·대기)·success=깨끗/종결.
const TRUST_COLUMN_DOT: Record<TrustColumnId, string> = {
  queued: 'bg-muted-foreground/40',
  running: 'bg-info',
  needs_input: 'bg-warning',
  claimed_done: 'bg-info',
  verified: 'bg-warning',
  merge_ready: 'bg-success',
  done: 'bg-success',
};

interface KanbanTrustColumnProps {
  id: TrustColumnId;
  label: string;
  locked: boolean;
  stories: KanbanStory[];
  epicMap: Record<string, string>;
  memberMap: Record<string, KanbanMember>;
  onStoryClick: (story: KanbanStory) => void;
  onEditStory?: (storyId: string) => void;
  // story #2933 H4 — settable 컬럼(queued/running/claimed_done/done) 카드는 모바일 등 드래그가
  // 안 되는 환경에서도 상태를 바꿀 수 있어야 한다(보드가 이미 그런 목적으로 이 콜백을 씀).
  // StoryCard 자체가 locked=true면 이 콜백을 받아도 메뉴 항목을 안 그린다(파생 컬럼은 여전히
  // 잠김) — 여기선 무조건 넘기고 잠금 판단은 StoryCard에 맡긴다(단일 판정 지점).
  onChangeStatus?: (storyId: string, newStatus: string) => void;
  onDeleteStory?: (storyId: string) => void;
  projectId?: string;
  onKickoffStory?: (storyId: string, result: 'triggered' | 'no_match' | 'conflict' | 'error') => void;
  executionMap?: Record<string, { status: string; rule_name?: string | null; completed_at?: string | null }>;
  blockedByMap?: Record<string, string[]>;
  storyLabelsMap?: Record<string, { id: string; name: string; color: string | null }[]>;
  storyGatesMap?: Record<string, { id: string; gate_type: string; status: string }[]>;
  storyLineMap?: Record<string, LineStatusSummary>;
  // story #2933 H4(PO 리뷰 질문, PR#3366 2026-08-22) — 드래그가 진행 중인지(어떤 카드든).
  // v4 아티팩트 §B("파생 3개가 «닫힌다»") — 파생 컬럼은 «항상» 무효 타깃이라 5-status의
  // dragStatus별 valid/invalid 판정과 달리 뭘 끌든 똑같이 닫힌다. 정적 상태(잠금배지+힌트
  // 텍스트, 위 locked && ...)는 이미 항상 보이지만, 드래그 中엔 흐림(opacity)까지 더해
  // "지금 이 순간 못 놓는다"는 동적 신호를 얹는다(resolveTrustColumnId의 조용한 무효화만으론
  // "왜 안 되는지" 안 보여 반쪽 — PO 지적).
  isDragging?: boolean;
}

/**
 * story #2933 H4(P0-H) — 6단계 신뢰축+완료 7컬럼 중 1개. KanbanColumn(5-status)과 별도
 * 컴포넌트로 새로 만든 이유: WIP limit·done-collapse·backlog 인라인 컴포저 등 KanbanColumn의
 * 부가 기능 대부분이 «status 컬럼» 전용 개념이라(WIP는 status별 한도, 컴포저는 backlog
 * 전용) 트러스트 컬럼엔 안 맞는다 — 억지로 끼워맞추느니 이 뷰가 실제로 필요한 최소(헤더+
 * 카드 목록+잠금 표시)만 담은 별도 컴포넌트가 더 정직하다(과결합 회피, 새 KanbanColumn prop
 * 10여개를 트러스트뷰용으로 옵셔널/무의미하게 늘리지 않음).
 *
 * locked=true(파생 컬럼: needs_input/verified/merge_ready) — useDroppable disabled로 이
 * 컬럼 자체가 드롭 타깃이 되지 않는다(kanban-board.tsx resolveTrustColumnId가 이미 한 번
 * 더 거르지만, 컬럼 레벨에서도 이중 방어). 카드도 locked를 전달받아 드래그 wiring이 꺼진다
 * (StoryCard locked prop). "왜 못 옮기나"는 카드별 사유(게이트 상세)까지는 이 뷰가 지어내지
 * 않는다(no-fiction — gate 상세 없이 추측 문구 금지) — 잠금 배지+헤더 설명 한 줄로 정직하게
 * "게이트가 정한다"만 말하고, 실제 사유는 카드 클릭→상세 패널(Workcell)에서 본다.
 */
export function KanbanTrustColumn({
  id, label, locked, stories, epicMap, memberMap, onStoryClick, onEditStory, onChangeStatus, onDeleteStory,
  projectId, onKickoffStory, executionMap, blockedByMap, storyLabelsMap, storyGatesMap, storyLineMap,
  isDragging = false,
}: KanbanTrustColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: locked });
  const t = useTranslations('board');
  const dotClass = TRUST_COLUMN_DOT[id];
  const closedDuringDrag = locked && isDragging;

  return (
    <div
      ref={setNodeRef}
      className={`flex h-full w-[280px] min-w-[240px] flex-col rounded-xl p-3 transition ${
        closedDuringDrag ? 'bg-muted/20 opacity-45' : locked ? 'bg-muted/20' : isOver ? 'bg-primary/5 ring-1 ring-primary/20' : 'bg-transparent'
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
          {label}
          {locked && <Lock className="size-3 text-muted-foreground" aria-hidden="true" />}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">{stories.length}</span>
      </div>
      {locked && (
        <p className={`mb-2 text-[10px] leading-snug ${closedDuringDrag ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
          {t('trustLockedDropHint')}
        </p>
      )}

      <SortableContextCompat items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy} disabled={locked}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 [&>*]:shrink-0">
          {stories.length === 0 ? (
            <div className="flex min-h-[100px] items-center justify-center px-4 text-center">
              <p className="text-xs text-muted-foreground">{t('noStories')}</p>
            </div>
          ) : null}
          {stories.map((story) => (
            <StoryCard
              key={story.id}
              story={story}
              epicName={story.epic_id ? epicMap[story.epic_id] : undefined}
              assignee={story.assignee_id ? memberMap[story.assignee_id] : undefined}
              assignees={(story.assignee_ids ?? []).flatMap((mid) => memberMap[mid] ? [memberMap[mid]] : [])}
              onClick={() => onStoryClick(story)}
              onEdit={onEditStory}
              onChangeStatus={onChangeStatus}
              onDelete={onDeleteStory}
              projectId={projectId}
              onKickoff={onKickoffStory}
              lastExecution={executionMap?.[story.id] ?? null}
              blockedBy={blockedByMap?.[story.id] ?? []}
              labels={storyLabelsMap?.[story.id] ?? []}
              gates={storyGatesMap?.[story.id] ?? []}
              lineStatus={storyLineMap?.[story.id]}
              verifiedBy={story.human_verified_by ? memberMap[story.human_verified_by] : undefined}
              locked={locked}
            />
          ))}
        </div>
      </SortableContextCompat>
    </div>
  );
}
