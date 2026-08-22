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
import { StoryDetailPanel, type Task } from '@/components/kanban/story-detail-panel';
import { useToast, ToastContainer } from '@/components/ui/toast';
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
// QA changes 7R(카디르+codex, 2026-08-22) — 원 발견의 «에픽» 절반: /api/goals도 동일
// maxLimit=100 clamp라 활성 에픽 100+ 프로젝트에서 레인 자체가 조용히 누락된다. stories
// 전용이던 헬퍼를 basePath 파라미터화해 goals에도 동형 적용(중복 루프 제거).
const PAGE_LIMIT = 100;
const PAGE_HARD_CAP = 50; // 안전판(최대 5000건) — 정상 프로젝트 규모를 크게 상회.

async function fetchAllPages<T>(basePath: string, projectId: string, source: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  let exhaustedNaturally = false;
  for (let page = 0; page < PAGE_HARD_CAP; page += 1) {
    const url = `${basePath}?project_id=${projectId}&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetchWithAuth(url);
    // ⚠️QA changes 8R HIGH②(카디르+codex, 2026-08-22) — 중간 페이지 실패를 `break`로 삼키면
    // 그때까지 모은 부분 집합을 완전 집합처럼 반환한다(6R/7R이 막으려던 "조용한 누락"과
    // 같은 클래스, 실패 경로에서 재발). 부분-성공을 허용하지 않는다 — throw해 호출부
    // (fetchAll)가 정직한 에러 상태로 처리하게 한다.
    if (!res.ok) {
      throw new Error(`${source}: 페이지 ${page} 로드 실패(status=${res.status})`);
    }
    const json = await res.json() as { data?: T[]; meta?: unknown };
    all.push(...(json.data ?? []));
    // story #2231 AC5 가드(pagination-envelope-consumers.test.ts) — meta 직접 옵셔널체이닝
    // 금지, 공유 parseCursorMeta()로만 읽는다(규약 밖 형태 조용히 낙하 방지). 변수명도
    // `meta`로 두면 가드의 텍스트 스캔이 `meta.hasMore`류로 오탐하므로 `pageMeta`로 회피
    // (기존 관용구 — agent-runs-list.tsx 등도 동일 이유로 변수 저장 없이 즉시 체이닝).
    const pageMeta = parseCursorMeta(json.meta, source);
    // QA changes 10R HIGH①(카디르+codex, 2026-08-22) — parseCursorMeta가 규약 밖 meta를
    // 만나면 "더 보기 없음"(hasMore=false)으로 낙하한다(다른 소비처엔 의도된 graceful
    // fallback, story #2231 AC4). 이 뷰는 «전체 집합 필수»라 그 낙하를 자연 소진과
    // 구분 못 하면 8R②/9R이 막은 것과 같은 클래스(부분 집합을 완전 집합처럼 반환)가 이
    // 경로로 재발한다 — malformed는 자연 소진이 아니라 throw(정직한 에러 상태로).
    if (pageMeta.malformed) {
      throw new Error(`${source}: 페이지 ${page} meta가 규약 A 형태가 아님 — 전체 집합 요구 뷰라 부분 반환 금지`);
    }
    // hasMore=true인데 nextCursor가 없는 모순 상태도 자연 소진이 아니다(같은 원칙).
    if (pageMeta.hasMore && !pageMeta.nextCursor) {
      throw new Error(`${source}: 페이지 ${page} hasMore=true인데 nextCursor 없음(모순) — 부분 반환 금지`);
    }
    if (!pageMeta.hasMore) { exhaustedNaturally = true; break; }
    cursor = pageMeta.nextCursor;
  }
  // QA changes 9R(카디르+codex, 2026-08-22) — 하드캡(PAGE_HARD_CAP) 소진 시 마지막 페이지가
  // hasMore=true였는데도 조용히 return하면 바로 위 8R②가 세운 "부분-성공 금지" 원칙이 이
  // 경로만 비켜간다(같은 클래스). 안전판 소진도 실패의 일종으로 취급해 throw — 기존
  // loadError 정직 표시로 통일.
  if (!exhaustedNaturally) {
    throw new Error(`${source}: 안전판(${PAGE_HARD_CAP}페이지) 소진 — 아직 더 있음(hasMore=true), 부분 집합을 반환하지 않는다.`);
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
  const [loadError, setLoadError] = useState(false);
  const [axisMode, setAxisMode] = useState<AxisMode>('status');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(null);
  const [storyTasks, setStoryTasks] = useState<Task[]>([]);
  const [storyTasksNextCursor, setStoryTasksNextCursor] = useState<string | null>(null);
  const [loadingMoreStoryTasks, setLoadingMoreStoryTasks] = useState(false);
  const { toasts, addToast, dismissToast } = useToast();

  useEffect(() => { setAxisMode(loadAxisMode(projectId)); }, [projectId]);

  // QA changes 10R HIGH③(카디르+codex, 2026-08-22) — 형제(kanban-board.tsx handleStoryClick)는
  // 카드 클릭 시 실제로 /api/tasks를 불러 StoryDetailPanel에 전달하는데 이 뷰는 tasks={[]}를
  // 하드코딩해 클릭할 때마다 "태스크가 없습니다"가 뜬다(실제 유무와 무관). 형제와 동형으로
  // selectedStoryId 변화에 맞춰 fetch한다.
  useEffect(() => {
    if (!selectedStoryId) {
      setStoryTasks([]);
      setStoryTasksNextCursor(null);
      return;
    }
    let cancelled = false;
    setStoryTasks([]);
    setStoryTasksNextCursor(null);
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/tasks?story_id=${selectedStoryId}&limit=20`);
        if (cancelled) return;
        if (res.ok) {
          const json = await res.json();
          setStoryTasks(json.data ?? []);
          setStoryTasksNextCursor(parseCursorMeta(json.meta, 'EpicSwimlaneBoard tasks').nextCursor);
        }
      } catch {
        if (!cancelled) { setStoryTasks([]); setStoryTasksNextCursor(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedStoryId]);
  const handleSetAxisMode = useCallback((mode: AxisMode) => {
    setAxisMode(mode);
    saveAxisMode(projectId, mode);
  }, [projectId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [stories, epics, membersRes] = await Promise.all([
        fetchAllPages<KanbanStory>('/api/stories', projectId, 'EpicSwimlaneBoard fetchAll(stories)'),
        fetchAllPages<KanbanEpic>('/api/goals', projectId, 'EpicSwimlaneBoard fetchAll(goals)'),
        fetchWithAuth(`/api/members?project_id=${projectId}`),
      ]);
      // story #2187/b8157376(kanban-board와 동형 불변식, QA changes 6R HIGH①) — is_excluded=true
      // (라이브 QA 임시 카드 등)는 삭제 권한이 없는 화면에서라도 무조건 숨긴다. 토글 없음 —
      // 노출되면 레인 카운트·상위3 큐레이션이 부풀려진다.
      setStories(stories.filter((s) => !s.is_excluded));
      setEpics(epics);
      if (membersRes.ok) { const json = await membersRes.json(); setMembers(json.data ?? []); }
      setLoadError(false);
    } catch {
      // QA changes 8R HIGH②(카디르+codex, 2026-08-22) — fetchAllPages가 이제 중간 실패를
      // throw로 승격하니 여기서 정직한 에러 상태로 받는다. stories/epics를 손대지 않고
      // (부분 데이터로 덮어써 "이 프로젝트엔 원래 이만큼만 있다"처럼 보이는 재발 방지)
      // 전용 에러 화면으로 대체한다.
      setLoadError(true);
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
    // 방지: status/epic_id만 바꾸고 trust_stage는 손대지 않는다. (QA changes 8R HIGH① 정정,
    // 카디르+codex 2026-08-22 — 예전 주석은 "다음 SSE/재조회가 채운다"였지만 이 컴포넌트엔
    // SSE 구독이 없어 거짓 주석이었다. 실제로는 아래 PATCH 응답 도착 시점에 직접 병합한다
    // — PO 조건② 재파생 폴백 금지는 그대로, 그 값을 어디서 얻는지만 정정.)
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
        // QA changes 8R HIGH①(카디르+codex, 2026-08-22) — 형제(kanban-board.tsx
        // handleTrustDragEnd, story #2933 H4 qa:changes)와 동형: 응답에 실린 진짜
        // trust_stage를 병합한다(재파생 아님, BE 판정값 그대로 — PO 조건②).
        const okItem = await res.json().then((j) => j?.data ?? null).catch(() => null);
        if (okItem && 'trust_stage' in okItem) {
          setStories((prev) => prev.map((s) => (s.id === storyId ? { ...s, trust_stage: okItem.trust_stage ?? null } : s)));
        }
      }
      if (columnChanged && newStatus) {
        const res = await fetchWithAuth('/api/stories/bulk', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ id: storyId, status: newStatus }] }),
        });
        if (!res.ok) { void fetchAll(); return; }
        const okItems = await res.json().then((j) => j?.data ?? j).catch(() => null);
        const okItem = Array.isArray(okItems) ? okItems.find((x) => x?.id === storyId) : null;
        // QA changes 10R HIGH②(카디르+codex, 2026-08-22) — bulk PATCH는 gate가 막은 항목도
        // HTTP200으로 반환하되 status는 기존값 유지+violation에 사유(story #2521 PO확定②안,
        // backend/app/routers/stories.py). 형제(kanban-board)는 이 상황을 SSE가 결국 채워
        // 정합시키지만 이 뷰엔 SSE 구독이 없다(원 스코프 밖) — 응답에 실린 진짜 status를
        // 즉시 병합해야만 gate 차단 낙관값이 영구 잔존하지 않는다(no-fiction, 재파생 아님).
        if (okItem) {
          if (okItem.violation) addToast({ type: 'warning', title: t('transitionViolation') });
          setStories((prev) => prev.map((s) => (s.id === storyId
            ? {
                ...s,
                status: typeof okItem.status === 'string' ? okItem.status : s.status,
                trust_stage: 'trust_stage' in okItem ? (okItem.trust_stage ?? null) : s.trust_stage,
              }
            : s)));
        }
      }
    } catch {
      void fetchAll(); // 네트워크 예외(fetch 자체가 throw) — 실패 시 재조회로 정직한 상태 복구.
    }
  }, [stories, columns, axisMode, fetchAll, addToast, t]);

  const selectedStory = selectedStoryId ? stories.find((s) => s.id === selectedStoryId) ?? null : null;

  // QA changes 10R(카디르+codex, 2026-08-22) — 형제(kanban-board)가 StoryDetailPanel에
  // 넘기는 계약면 grep 전수 대조. storyMap/epicMap은 이 뷰가 이미 들고 있는 stories/epics로
  // 공짜로 만들 수 있다(의존성 그래프 다른-스토리 이름 표시·클릭 이동용) — sprintMap은
  // 이 뷰가 sprint를 아예 fetch하지 않아 제외(활동로그 표시용 코스메틱 폴백뿐이라 비차단,
  // sprintName() 부재 시 "—"로 안전 낙하 — overlayPosition도 이 뷰는 팝오버 아닌 전체화면
  // 드로어라 N/A, 형제와 동형).
  const storyMap = useMemo(() => {
    const map: Record<string, { title: string; status: string }> = {};
    for (const s of stories) map[s.id] = { title: s.title, status: s.status };
    return map;
  }, [stories]);
  const epicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of epics) map[e.id] = e.title;
    return map;
  }, [epics]);

  return (
    <>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('epicSwimlaneTitle')}</h1>} showContextChip />
      <div className="space-y-3 p-4">
        <WorkspaceFrameTabs active="epic" />

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">{t('loading')}</div>
        ) : loadError ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <p role="alert" className="text-sm text-destructive">{t('epicSwimlaneLoadError')}</p>
            <button
              type="button"
              onClick={() => { void fetchAll(); }}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              {t('epicSwimlaneRetry')}
            </button>
          </div>
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
                tasks={storyTasks}
                nextTasksCursor={storyTasksNextCursor}
                loadingMoreTasks={loadingMoreStoryTasks}
                onLoadMoreTasks={async () => {
                  if (!selectedStoryId || !storyTasksNextCursor) return;
                  setLoadingMoreStoryTasks(true);
                  try {
                    const res = await fetchWithAuth(`/api/tasks?story_id=${selectedStoryId}&limit=20&cursor=${encodeURIComponent(storyTasksNextCursor)}`);
                    if (res.ok) {
                      const json = await res.json();
                      setStoryTasks((prev) => {
                        const existingIds = new Set(prev.map((task) => task.id));
                        return [...prev, ...((json.data ?? []) as Task[]).filter((task) => !existingIds.has(task.id))];
                      });
                      setStoryTasksNextCursor(parseCursorMeta(json.meta, 'EpicSwimlaneBoard tasks(loadMore)').nextCursor);
                    }
                  } finally {
                    setLoadingMoreStoryTasks(false);
                  }
                }}
                onClose={() => setSelectedStoryId(null)}
                memberMap={memberMap}
                members={members}
                storyMap={storyMap}
                epicMap={epicMap}
                projectId={projectId}
                onNavigate={(storyId) => setSelectedStoryId(storyId)}
                onStoryUpdate={(updated) => setStories((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)))}
                onDeleteSuccess={(id) => {
                  setStories((prev) => prev.filter((s) => s.id !== id));
                  setSelectedStoryId(null);
                }}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
