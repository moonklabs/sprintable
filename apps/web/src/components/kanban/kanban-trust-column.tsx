'use client';

import type { ComponentType } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTranslations } from 'next-intl';
import { Lock, Plus } from 'lucide-react';
import { StoryCard } from './story-card';
import type { KanbanStory, KanbanMember, LineStatusSummary, TrustColumnId } from './types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LAYER } from '@/components/ds/layers';

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
  queued: 'bg-ds-ink-3',
  running: 'bg-ds-info',
  needs_input: 'bg-ds-needs-hand-bar',
  claimed_done: 'bg-ds-info',
  verified: 'bg-ds-needs-hand-bar',
  merge_ready: 'bg-ds-done',
  done: 'bg-ds-done',
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
  // story #2949 — settable 컬럼(locked=false: queued/running/claimed_done/done) 전용 인라인
  // 컴포저. KanbanColumn(kanban-column.tsx)의 동일 기능을 그대로 이식(발명 0) — 다만 이 컬럼은
  // "story status"가 아니라 TrustColumnId를 다루므로, id(TrustColumnId)→실제 status 매핑은
  // 호출자(kanban-board.tsx, TRUST_COLUMN_TO_STATUS)가 onCreateStory 넘기기 前에 해소한다 —
  // 이 컴포넌트는 그 매핑을 몰라도 된다(과결합 회피, 이 파일 상단 설계 원칙 그대로).
  onCreateStory?: (columnId: string, title: string) => Promise<void> | void;
  // f1910a31과 동형 — nonce가 바뀔 때마다(0→1, 1→2…) 컴포저 재오픈. CTA가 트러스트 뷰에서도
  // 바로 열리게(축 전환 브리지 제거, story #2949).
  autoComposeSignal?: number;
  // story #2933 H4(PO 리뷰 질문, PR#3366 2026-08-22) — 드래그가 진행 중인지(어떤 카드든).
  // v4 아티팩트 §B("파생 3개가 «닫힌다»") — 파생 컬럼은 «항상» 무효 타깃이라 5-status의
  // dragStatus별 valid/invalid 판정과 달리 뭘 끌든 똑같이 닫힌다. 정적 상태(잠금배지+힌트
  // 텍스트, 위 locked && ...)는 이미 항상 보이지만, 드래그 中엔 흐림(opacity)까지 더해
  // "지금 이 순간 못 놓는다"는 동적 신호를 얹는다(resolveTrustColumnId의 조용한 무효화만으론
  // "왜 안 되는지" 안 보여 반쪽 — PO 지적).
  isDragging?: boolean;
  /** story #3287 AC4 — 카드 내부 상태 배지는 story.status(canonical, trust_stage와 무관)를
   * 보여주므로 트러스트 뷰 카드에도 그대로 threading한다. 컬럼 헤더 라벨(이 컴포넌트의
   * `label` prop) 자체는 별개 어휘(TRUST_COLUMNS)라 여긴 안 건드림 — kanban-board.tsx가
   * TRUST_COLUMNS엔 이 override를 안 씀. */
  getStatusLabel?: (canonicalSlug: string) => string | undefined;
  // story #4888 — same «N+» and «더 보기» as the classic column (KanbanColumn): the cards of a status are loaded a page at a time, and without these the cards past the first page of the
  // default view could not be reached. hasMore = some status that feeds this column still has a page to load; onLoadMore loads the next page of each of those statuses.
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** hasMore, but this column has no button: its cards arrive with the page of the settable column that shares the status (derived columns). Only the «N+» shows. */
  moreViaFeeder?: boolean;
  /** 4908 — 상세 패널이 열려 있는 카드(열린 카드 층). */
  selectedStoryId?: string | null;
  /** 4908 — 카드 메뉴 «담당자 ▸» 후보 · 켜고 끄기 · 제목 바로 바꾸기(호출부 소유). */
  assignableMembers?: KanbanMember[];
  onToggleAssignee?: (storyId: string, memberId: string) => void;
  onRenameStory?: (storyId: string, title: string) => void;
}

/**
 * story #2933 H4(P0-H) — 6단계 신뢰축+완료 7컬럼 중 1개. KanbanColumn(5-status)과 별도
 * 컴포넌트로 새로 만든 이유: WIP limit·done-collapse 등 KanbanColumn의 부가 기능 대부분이
 * «status 컬럼» 전용 개념이라(WIP는 status별 한도) 트러스트 컬럼엔 안 맞는다 — 억지로
 * 끼워맞추느니 이 뷰가 실제로 필요한 최소만 담은 별도 컴포넌트가 더 정직하다(과결합 회피).
 * 단 인라인 컴포저는 예외(story #2949) — 트러스트 축이 기본이 된 이상 "기본 화면에서 바로
 * 스토리 생성"은 1급 경로라 settable 컬럼(locked=false)에 KanbanColumn과 동형으로 이식했다
 * (발명 0). id(TrustColumnId)→실제 story status 매핑은 이 컴포넌트가 모른다 — 호출자
 * (kanban-board.tsx)가 TRUST_COLUMN_TO_STATUS로 해소한 뒤 onCreateStory를 넘긴다.
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
  onCreateStory, autoComposeSignal, isDragging = false, getStatusLabel,
  hasMore = false, loadingMore = false, onLoadMore, moreViaFeeder = false, selectedStoryId = null, assignableMembers, onToggleAssignee, onRenameStory,
}: KanbanTrustColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: locked });
  const t = useTranslations('board');
  const dotClass = TRUST_COLUMN_DOT[id];
  const closedDuringDrag = locked && isDragging;

  const [composing, setComposing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoComposeSignal && autoComposeSignal > 0) setComposing(true);
  }, [autoComposeSignal]);

  const startCompose = () => {
    setDraftTitle('');
    setComposing(true);
  };
  const cancelCompose = () => {
    setComposing(false);
    setDraftTitle('');
  };
  const submitCompose = async () => {
    const title = draftTitle.trim();
    if (!title || !onCreateStory || submitting) return;
    setSubmitting(true);
    try {
      await onCreateStory(id, title);
      setDraftTitle('');
      setComposing(false);
    } finally {
      setSubmitting(false);
    }
  };

  // story #4888(UI-5 보드 머리 첫 조각, AC3 §4-3 «잠긴 두 열은 비어 있을 때 좁은 띠로») — 잠긴(파생) 열이 비어 있으면 280px 칸 대신 띠 하나(40px)로 접는다.
  // 열이 «있다»는 사실은 그대로(이름 · 자물쇠 · 0건이 띠에 남음 · 드롭 불가 안내는 title · 스크린리더 글자로) — 지우는 게 아니라 좁히는 것.
  // 카드가 1장이라도 생기거나 더 불러올 쪽(hasMore · N+)이 있으면 곧바로 원래 칸으로 선다. 끌기 중에도 띠는 띠 그대로다(칸 폭이 끌기 도중 바뀌면 놓을 자리 판정이 흔들린다) — 대신 흐려진다.
  if (locked && stories.length === 0 && !hasMore && !composing) {
    return (
      <div
        ref={setNodeRef}
        data-testid={`trust-column-strip-${id}`}
        data-trust-column={id}
        title={`${label} · ${t('trustLockedDropHint')}`}
        className={`flex h-full w-10 min-w-10 shrink-0 flex-col items-center gap-2 rounded-xl border border-dashed border-ds-line ${LAYER.panel} py-3 transition lg:[@media(max-height:520px)]:py-2 ${closedDuringDrag ? 'opacity-45' : ''}`}
      >
        <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
        {/* story #4923(재오픈) — 띠가 낮은 창(1100×420: 칸 127px)에서 세로 글이 «입력필 / 요»로 두 줄로 갈라졌다: 글은 줄을 바꾸지 않고(whitespace-nowrap) 한 줄로 서되 자리가 모자라면(더 낮은 창 · 확대 · 더 긴 글) 줄바꿈 · 겹침 대신 «…»로 잘린다(min-h-0 · overflow-hidden · text-ellipsis — 전체 이름은 띠 title이 말한다), 낮은 데스크톱 창(높이 ≤ 520)에선 장식인 자물쇠를 빼고(잠금은 점선 테두리 · title · 스크린리더 글이 그대로 말한다 · 20px)
            위아래 여백을 12 → 8로 줄인다(8px). 띠 = 점 6 + 글(ko ≈ 58 · en ≈ 74) + 0 16 + 사이 16 + 위아래 16이 칸 높이(139: 칸 바깥 여백을 줄인 뒤) 안에 한 줄로 든다. */}
        <Lock className="size-3 text-ds-ink-3 lg:[@media(max-height:520px)]:hidden" aria-hidden="true" />
        <span className="min-h-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-extrabold text-ds-ink [writing-mode:vertical-rl]">{label}</span>
        <span className="text-xs tabular-nums text-ds-ink-3">0</span>
        <span className="sr-only">{t('trustLockedDropHint')}</span>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      data-board-column={id}
      // 4908 — 열은 «내용 칸 층»(LAYER.panel): 바탕과 카드 사이를 면으로 가른다(바탕 → 열 ≥ 0.03 · 열 → 카드 ≥ 0.05, layer-rule.test). 잠긴 열은 같은 면에 안내 글만 다르다.
      className={`flex h-full w-[280px] min-w-[240px] flex-col rounded-xl border p-3 transition lg:[@media(max-height:520px)]:py-2 ${LAYER.panel} ${
        closedDuringDrag ? 'border-ds-line opacity-45' : isOver ? 'border-ds-action ring-1 ring-ds-action' : 'border-ds-line'
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-2 lg:[@media(max-height:520px)]:mb-2">
        {/* story #2969 §1.3-b(doc proofline-system-layer-2969, PR-6) — 유나 실픽셀 갭 fix:
            kanban-column.tsx(클래식 축)만 하고 이 파일(6단계 신뢰축=기본 보드 화면)을
            놓쳤던 것. 컬럼헤더=소헤딩(Heading 무게), 크기(text-xs)·sans 불변. */}
        <h3 className="flex items-center gap-2 text-xs font-extrabold text-ds-ink">
          <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
          {label}
          {locked && <Lock className="size-3 text-ds-ink-3" aria-hidden="true" />}
        </h3>
        <div className="flex items-center gap-1.5">
          <span className="text-xs tabular-nums text-ds-ink-3">{hasMore ? `${stories.length}+` : stories.length}</span>
          {!locked && onCreateStory ? (
            <button
              type="button"
              aria-label={t('addStory')}
              title={t('addStory')}
              onClick={startCompose}
              className="flex h-5 w-5 items-center justify-center rounded text-ds-ink-3 transition hover:bg-ds-surface-high hover:text-ds-ink"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      {locked && (
        <p className={`mb-2 text-micro leading-snug ${closedDuringDrag ? 'font-semibold text-ds-ink' : 'text-ds-ink-3'}`}>
          {t('trustLockedDropHint')}
        </p>
      )}

      {!locked && composing ? (
        <div className="mb-2 rounded-xl border border-primary/30 bg-background/50 p-2">
          <Input
            ref={inputRef}
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitCompose();
              } else if (e.key === 'Escape') {
                cancelCompose();
              }
            }}
            placeholder={t('addStoryPlaceholder')}
            className="h-8 text-base lg:text-sm"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="default"
              className="h-7 px-2 text-xs"
              onClick={() => void submitCompose()}
              disabled={submitting || !draftTitle.trim()}
            >
              {t('addStorySubmit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={cancelCompose}
            >
              {t('addStoryCancel')}
            </Button>
          </div>
        </div>
      ) : null}

      <SortableContextCompat items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy} disabled={locked}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 [&>*]:shrink-0">
          {stories.length === 0 && !composing ? (
            <div className="flex min-h-[100px] items-center justify-center px-4 text-center">
              <p className="text-xs text-ds-ink-3">{t('noStories')}</p>
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
              getStatusLabel={getStatusLabel}
              selected={selectedStoryId === story.id}
              assignableMembers={assignableMembers}
              onToggleAssignee={onToggleAssignee}
              onRename={onRenameStory}
              showStatus={id === 'queued'}
            />
          ))}
          {hasMore && !moreViaFeeder && onLoadMore ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="h-7 min-h-0 w-full px-3 text-xs text-muted-foreground disabled:opacity-50"
            >
              {loadingMore ? t('loading') : t('loadMore')}
            </Button>
          ) : null}
        </div>
      </SortableContextCompat>
    </div>
  );
}
