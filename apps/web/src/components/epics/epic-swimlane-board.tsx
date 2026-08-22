'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  DndContext, type DragEndEvent, PointerSensor, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { fetchWithAuth } from '@/lib/db/client';
import { parseCursorMeta } from '@/lib/pagination';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { StoryCard } from '@/components/kanban/story-card';
import { StoryDetailPanel } from '@/components/kanban/story-detail-panel';
import { WorkspaceFrameTabs } from '@/components/workspace/workspace-frame-tabs';
import {
  COLUMNS, TRUST_COLUMNS, TRUST_COLUMN_TO_STATUS,
  type KanbanEpic, type KanbanMember, type KanbanStory, type TrustColumnId,
} from '@/components/kanban/types';

// story #2931(2930-I3 분리, 유나 (a) 시안 확定 2026-08-22) — 워크스페이스 «뷰» 3종(보드·
// 스프린트·에픽) 중 코드 실체가 없던 마지막 조각. 행=에픽(+미할당 레인), 열=H4(#2933)가
// 이미 만든 컬럼 축(5-status/6단계 신뢰축) — 별개 축 재발명이 아니라 COLUMNS/TRUST_COLUMNS/
// TRUST_COLUMN_TO_STATUS 상수 그대로 재사용. 드래그로 스윔레인을 넘기면 story.epic_id를
// PATCH(시각만 아니라 실 재배정) — KanbanColumn/KanbanTrustColumn을 그대로 끼워 쓰지 않고
// (그 둘은 "1개 세로 목록" 전용 조립이라 "여러 레인 × 여러 컬럼" 격자에 안 맞는다) 이 화면이
// 실제로 필요한 최소(레인 헤더+가로 컬럼 셀)만 담은 별도 컴포넌트로 새로 짠다(H4 KanbanTrustColumn
// 신설 때와 동일한 판단 — 억지로 끼워맞추느니 정직한 별도 컴포넌트, 과결합 회피).

const TOP_LANE_COUNT = 3;
const UNASSIGNED_LANE_ID = '__unassigned__';

// QA changes 6R HIGH②(카디르+codex, 2026-08-22) — /api/stories 프록시는 요청 limit과 무관
// 하게 서버에서 maxLimit=100으로 clamp한다(apps/web/src/app/api/stories/route.ts). 기존
// limit=1000 단발 요청은 100건 초과 프로젝트에서 hasMore/nextCursor를 소비하지 않은 채
// 조용히 잘려 레인 카운트·상위3 큐레이션이 틀어졌다. 이 뷰는 kanban-board(컬럼별 "더보기"
// UX)와 달리 레인×컬럼 버킷팅 자체가 «전체 집합»을 요구해 부분 로드로는 정직할 수 없다 —
// hasMore가 꺼질 때까지 커서를 소진한다("정직한 더-있음 표시"보다 전량 소진이 이 뷰엔 맞음).
const STORY_PAGE_LIMIT = 100;
const STORY_PAGE_HARD_CAP = 50; // 안전판(최대 5000건) — 정상 프로젝트 규모를 크게 상회.

async function fetchAllStoryPages(projectId: string): Promise<KanbanStory[]> {
  const all: KanbanStory[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < STORY_PAGE_HARD_CAP; page += 1) {
    const url = `/api/stories?project_id=${projectId}&limit=${STORY_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetchWithAuth(url);
    if (!res.ok) break;
    const json = await res.json() as { data?: KanbanStory[]; meta?: unknown };
    all.push(...(json.data ?? []));
    // story #2231 AC5 가드(pagination-envelope-consumers.test.ts) — meta 직접 옵셔널체이닝
    // 금지, 공유 parseCursorMeta()로만 읽는다(규약 밖 형태 조용히 낙하 방지). 변수명도
    // `meta`로 두면 가드의 텍스트 스캔이 `meta.hasMore`류로 오탐하므로 `pageMeta`로 회피
    // (기존 관용구 — agent-runs-list.tsx 등도 동일 이유로 변수 저장 없이 즉시 체이닝).
    const pageMeta = parseCursorMeta(json.meta, 'EpicSwimlaneBoard fetchAllStoryPages');
    if (!pageMeta.hasMore || !pageMeta.nextCursor) break;
    cursor = pageMeta.nextCursor;
  }
  return all;
}

type AxisMode = 'status' | 'trust';

function axisModeKey(projectId: string | undefined): string {
  return `epic_swimlane_axis_mode_${projectId ?? 'default'}`;
}
function loadAxisMode(projectId: string | undefined): AxisMode {
  if (typeof window === 'undefined') return 'status';
  try {
    return window.localStorage.getItem(axisModeKey(projectId)) === 'trust' ? 'trust' : 'status';
  } catch {
    return 'status';
  }
}
function saveAxisMode(projectId: string | undefined, mode: AxisMode): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(axisModeKey(projectId), mode); } catch { /* private mode 등 — 무해 */ }
}

function storyColumnId(story: KanbanStory, axisMode: AxisMode): string | null {
  if (axisMode === 'status') return story.status;
  if (story.status === 'done') return 'done';
  return story.trust_stage ?? null;
}

interface SwimlaneCellProps {
  laneId: string;
  columnId: string;
  locked: boolean;
  stories: KanbanStory[];
  memberMap: Record<string, KanbanMember>;
  onStoryClick: (story: KanbanStory) => void;
}

function SwimlaneCell({ laneId, columnId, locked, stories, memberMap, onStoryClick }: SwimlaneCellProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `${laneId}::${columnId}`, disabled: locked });
  return (
    <div
      ref={setNodeRef}
      className={`flex h-full min-h-[64px] w-[220px] shrink-0 flex-col gap-1.5 rounded-lg p-1.5 transition ${
        locked ? 'bg-muted/20' : isOver ? 'bg-primary/5 ring-1 ring-primary/20' : 'bg-transparent'
      }`}
    >
      {stories.map((story) => (
        <StoryCard
          key={story.id}
          story={story}
          assignee={story.assignee_id ? memberMap[story.assignee_id] : undefined}
          assignees={(story.assignee_ids ?? []).flatMap((id) => memberMap[id] ? [memberMap[id]] : [])}
          onClick={() => onStoryClick(story)}
          locked={locked}
        />
      ))}
    </div>
  );
}

// 컬럼 라벨은 레인마다 반복하면 소음(모든 레인이 같은 축을 공유하므로) — 격자 맨 위에
// 한 번만 그린다(KanbanColumn/KanbanTrustColumn의 헤더를 레인 수만큼 복제하는 대신, 셀
// 너비(w-[220px])만 맞춰 아래 각 레인의 SwimlaneCell과 시각적으로 정렬).
function SwimlaneColumnHeader({ columns }: { columns: readonly { id: string; label: string; locked: boolean }[] }) {
  return (
    <div className="flex gap-2 border-b border-border px-1 pb-1.5">
      {columns.map((col) => (
        <div key={col.id} className="w-[220px] shrink-0 text-xs font-semibold text-foreground">
          {col.label}
        </div>
      ))}
    </div>
  );
}

interface SwimlaneRowProps {
  laneId: string;
  title: string;
  subtitle?: string;
  columns: readonly { id: string; label: string; locked: boolean }[];
  stories: KanbanStory[];
  axisMode: AxisMode;
  memberMap: Record<string, KanbanMember>;
  onStoryClick: (story: KanbanStory) => void;
}

function SwimlaneRow({ laneId, title, subtitle, columns, stories, axisMode, memberMap, onStoryClick }: SwimlaneRowProps) {
  const byColumn = useMemo(() => {
    const map: Record<string, KanbanStory[]> = {};
    for (const col of columns) map[col.id] = [];
    for (const s of stories) {
      const col = storyColumnId(s, axisMode);
      if (col && map[col]) map[col].push(s);
    }
    return map;
  }, [stories, columns, axisMode]);

  return (
    <div className="border-b border-border/60 py-2">
      <div className="mb-1.5 flex items-baseline gap-2 px-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
        <span className="text-xs tabular-nums text-muted-foreground">{stories.length}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {columns.map((col) => (
          <SwimlaneCell
            key={col.id}
            laneId={laneId}
            columnId={col.id}
            locked={col.locked}
            stories={byColumn[col.id] ?? []}
            memberMap={memberMap}
            onStoryClick={onStoryClick}
          />
        ))}
      </div>
    </div>
  );
}

export function EpicSwimlaneBoard({ projectId }: { projectId: string }) {
  const t = useTranslations('board');
  const [stories, setStories] = useState<KanbanStory[]>([]);
  const [epics, setEpics] = useState<KanbanEpic[]>([]);
  const [members, setMembers] = useState<KanbanMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [axisMode, setAxisMode] = useState<AxisMode>('status');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);

  useEffect(() => { setAxisMode(loadAxisMode(projectId)); }, [projectId]);
  const handleSetAxisMode = useCallback((mode: AxisMode) => {
    setAxisMode(mode);
    saveAxisMode(projectId, mode);
  }, [projectId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [stories, epicsRes, membersRes] = await Promise.all([
        fetchAllStoryPages(projectId),
        fetchWithAuth(`/api/goals?project_id=${projectId}&limit=100`),
        fetchWithAuth(`/api/members?project_id=${projectId}`),
      ]);
      // story #2187/b8157376(kanban-board와 동형 불변식, QA changes 6R HIGH①) — is_excluded=true
      // (라이브 QA 임시 카드 등)는 삭제 권한이 없는 화면에서라도 무조건 숨긴다. 토글 없음 —
      // 노출되면 레인 카운트·상위3 큐레이션이 부풀려진다.
      setStories(stories.filter((s) => !s.is_excluded));
      if (epicsRes.ok) { const json = await epicsRes.json(); setEpics(json.data ?? []); }
      if (membersRes.ok) { const json = await membersRes.json(); setMembers(json.data ?? []); }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const memberMap = useMemo(() => {
    const map: Record<string, KanbanMember> = {};
    for (const m of members) map[m.id] = m;
    return map;
  }, [members]);

  // doc §"기본 active만" — status==='active'인 에픽만(값이 없는 옛 백필 미스도 active로
  // 취급 — 정직한 값 부재를 숨김으로 벌하지 않는다). 정렬은 position(로드맵 큐레이션,
  // #2933 이전부터 이미 있던 필드)이 있으면 그걸, 없으면 최근 것 우선(추가 정보 0 상태에서의
  // 합리적 기본 — 큐레이션 안 된 에픽은 "최근에 만든 게 아마 지금 보는 것"이 대체로 맞다).
  const activeEpics = useMemo(() => {
    return epics
      .filter((e) => (e.status ?? 'active') === 'active')
      .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  }, [epics]);
  const topEpics = activeEpics.slice(0, TOP_LANE_COUNT);
  const overflowEpics = activeEpics.slice(TOP_LANE_COUNT);

  const storiesByEpic = useMemo(() => {
    const map: Record<string, KanbanStory[]> = {};
    const unassigned: KanbanStory[] = [];
    for (const s of stories) {
      if (s.epic_id) (map[s.epic_id] ??= []).push(s);
      else unassigned.push(s);
    }
    return { map, unassigned };
  }, [stories]);

  const columns = axisMode === 'status'
    ? COLUMNS.map((c) => ({ id: c.id as string, label: t(c.i18nKey), locked: false }))
    : TRUST_COLUMNS.map((c) => ({ id: c.id as string, label: t(c.i18nKey), locked: c.locked }));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const storyId = String(active.id);
    const overId = String(over.id);
    const sep = overId.lastIndexOf('::');
    if (sep === -1) return;
    const targetLaneId = overId.slice(0, sep);
    const targetColumnId = overId.slice(sep + 2);

    const story = stories.find((s) => s.id === storyId);
    if (!story) return;

    const targetLocked = columns.find((c) => c.id === targetColumnId)?.locked;
    if (targetLocked) return; // 파생 컬럼 드롭 무효(H4와 동형 규율).

    const currentLaneId = story.epic_id ?? UNASSIGNED_LANE_ID;
    const currentColumnId = storyColumnId(story, axisMode);
    const laneChanged = currentLaneId !== targetLaneId;
    const columnChanged = currentColumnId !== targetColumnId;
    if (!laneChanged && !columnChanged) return;

    const newEpicId = targetLaneId === UNASSIGNED_LANE_ID ? null : targetLaneId;
    const newStatus = axisMode === 'trust'
      ? TRUST_COLUMN_TO_STATUS[targetColumnId as TrustColumnId]
      : targetColumnId;

    // 낙관 갱신 — story #2933 H4 qa:changes 교훈(trust_stage 스프레드-보존 실종 버그) 재발
    // 방지: status/epic_id만 바꾸고 trust_stage는 손대지 않는다(다음 SSE/재조회가 진짜 값을
    // 채운다 — PO 조건② 재파생 폴백 금지 그대로).
    setStories((prev) => prev.map((s) => (
      s.id === storyId
        ? { ...s, epic_id: newEpicId, status: (columnChanged && newStatus) ? newStatus : s.status }
        : s
    )));

    // ⚠️QA changes(PR#3377 HIGH, 카디르+codex, 2026-08-22) — fetchWithAuth는 401 외의
    // 비-2xx(500 등)를 res.ok=false Response로 «그냥 반환»할 뿐 throw하지 않는다(코드
    // 확認 — 재시도는 401 전용). try/catch만으론 그 흔한 실패 모드를 영영 못 잡아
    // "부분 실패=재조회로 정직 복구" claim이 실제로는 안 돌았다(낙관 UI가 서버 truth와
    // 불일치한 채 영구 잔존 — no-fiction 위반). 형제(kanban-board.tsx handleDragEnd/
    // handleTrustDragEnd)가 이미 쓰는 `if (!res.ok)` 명시 체크를 그대로 적용.
    try {
      if (laneChanged) {
        const res = await fetchWithAuth(`/api/stories/${storyId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epic_id: newEpicId }),
        });
        if (!res.ok) { void fetchAll(); return; }
      }
      if (columnChanged && newStatus) {
        const res = await fetchWithAuth('/api/stories/bulk', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ id: storyId, status: newStatus }] }),
        });
        if (!res.ok) { void fetchAll(); return; }
      }
    } catch {
      void fetchAll(); // 네트워크 예외(fetch 자체가 throw) — 실패 시 재조회로 정직한 상태 복구.
    }
  }, [stories, columns, axisMode, fetchAll]);

  const selectedStory = selectedStoryId ? stories.find((s) => s.id === selectedStoryId) ?? null : null;

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('epicSwimlaneTitle')}</h1>} showContextChip />
      <div className="space-y-3 p-4">
        <WorkspaceFrameTabs active="epic" />

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">{t('loading')}</div>
        ) : (
          <>
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold text-foreground">{t('epicSwimlaneTitle')}</h2>
              <div className="flex items-center gap-3 border-b border-border/60">
                <button
                  type="button"
                  role="tab"
                  aria-selected={axisMode === 'status'}
                  onClick={() => handleSetAxisMode('status')}
                  className={`-mb-px whitespace-nowrap border-b-2 px-0.5 pb-1.5 text-[11px] font-semibold transition ${
                    axisMode === 'status' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t('trustClassicView')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={axisMode === 'trust'}
                  onClick={() => handleSetAxisMode('trust')}
                  className={`-mb-px whitespace-nowrap border-b-2 px-0.5 pb-1.5 text-[11px] font-semibold transition ${
                    axisMode === 'trust' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t('trustAxisView')}
                </button>
              </div>
            </div>

            <SwimlaneColumnHeader columns={columns} />

            <DndContext sensors={sensors} onDragEnd={(e) => { void handleDragEnd(e); }}>
              <div>
                {topEpics.map((epic) => (
                  <SwimlaneRow
                    key={epic.id}
                    laneId={epic.id}
                    title={epic.title}
                    columns={columns}
                    stories={storiesByEpic.map[epic.id] ?? []}
                    axisMode={axisMode}
                    memberMap={memberMap}
                    onStoryClick={(s) => setSelectedStoryId(s.id)}
                  />
                ))}

                {overflowEpics.length > 0 && (
                  <div className="border-b border-border/60 py-1">
                    <button
                      type="button"
                      onClick={() => setOverflowOpen((v) => !v)}
                      className="flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      {overflowOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                      {t('epicSwimlaneOverflowToggle', { count: overflowEpics.length })}
                    </button>
                    {overflowOpen && overflowEpics.map((epic) => (
                      <SwimlaneRow
                        key={epic.id}
                        laneId={epic.id}
                        title={epic.title}
                        columns={columns}
                        stories={storiesByEpic.map[epic.id] ?? []}
                        axisMode={axisMode}
                        memberMap={memberMap}
                        onStoryClick={(s) => setSelectedStoryId(s.id)}
                      />
                    ))}
                  </div>
                )}

                <SwimlaneRow
                  laneId={UNASSIGNED_LANE_ID}
                  title={t('epicSwimlaneUnassigned')}
                  columns={columns}
                  stories={storiesByEpic.unassigned}
                  axisMode={axisMode}
                  memberMap={memberMap}
                  onStoryClick={(s) => setSelectedStoryId(s.id)}
                />
              </div>
            </DndContext>

            {selectedStory && (
              <StoryDetailPanel
                story={selectedStory}
                tasks={[]}
                onClose={() => setSelectedStoryId(null)}
                memberMap={memberMap}
                onStoryUpdate={(updated) => setStories((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)))}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
