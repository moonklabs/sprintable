/**
 * E-GLANCE C1 — "감시 아닌 신뢰" 현황판. UX handoff doc(`e-glance-glance-board-handoff`, 유나
 * 2026-07-10) §1 감시-게이트 리트머스: 주어=프로젝트/팀(개인 성적·순위·처리량 절대 노출 0).
 *
 * 데이터 소스는 전부 실 확인(grounding, 추정 0):
 * - 로드맵 순서: `GET /api/epics?project_id=`(created_at asc) — 에픽에 전용 큐 순서 컬럼 없음
 *   (`IEpicRepository.ts` 확인) 확인 후 fallback으로 created_at 사용(§10 "없으면 sort_order"
 *   상당 — 실제로는 sort_order 컬럼 자체가 없어 created_at이 유일한 실 정렬키).
 * - 진척(done/total/completion_pct): `GET /api/dashboard/overview`의
 *   `project_status.epics: EpicProgress[]`(command-center/types.ts 기존 실 타입 재사용).
 * - 참여(협업 지도): `GET /api/stories?epic_id=`의 `assignee_id`(core-storage `Story` 인터페이스
 *   확인 — `assignee_ids` 배열은 이 FE 스토리 레포지토리엔 없음, 단일 `assignee_id`만 실재).
 * - 생동 스트림: `GET /api/activity-logs?project_id=`(기존 `DashboardActivityTimeline` 소비 확인).
 */

import type { EpicProgress } from '@/components/dashboard/command-center/types';

export type RoadmapStatus = 'done' | 'active' | 'upcoming';

export interface RoadmapEpic {
  id: string;
  title: string;
  roadmapStatus: RoadmapStatus;
  done: number;
  total: number;
  completionPct: number;
}

/** `GET /api/epics` 응답 항목(core-storage `Epic` 인터페이스 미러, 필요 필드만). */
export interface BeEpicListItem {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

/** epic.status(draft|active|done|archived — `epic-permissions.ts` ALLOWED_TRANSITIONS 확인)를 3버킷 로드맵 상태로 유도. */
export function deriveRoadmapStatus(beStatus: string): RoadmapStatus {
  if (beStatus === 'done' || beStatus === 'archived') return 'done';
  if (beStatus === 'active') return 'active';
  return 'upcoming';
}

/** 에픽 목록(순서 SSOT) + 진척 데이터(별 엔드포인트)를 epic id로 병합 — 진척 누락 시 0/0(결핍 아닌 "시작 전"). */
export function mergeRoadmap(epics: BeEpicListItem[], progress: EpicProgress[]): RoadmapEpic[] {
  const progressById = new Map(progress.map((p) => [p.epic_id, p]));
  return epics.map((e) => {
    const p = progressById.get(e.id);
    return {
      id: e.id,
      title: e.title,
      roadmapStatus: deriveRoadmapStatus(e.status),
      done: p?.done ?? 0,
      total: p?.total ?? 0,
      completionPct: p?.completion_pct ?? 0,
    };
  });
}

export type ProgressPhrase = 'notStarted' | 'justStarted' | 'underway' | 'almostThere' | 'wrappingUp';

/** %숫자 강박 아닌 정성 언어 우선(§4) — 숫자는 보조. */
export function derivePhrase(completionPct: number, total: number): ProgressPhrase {
  if (total === 0 || completionPct <= 0) return 'notStarted';
  if (completionPct < 25) return 'justStarted';
  if (completionPct < 60) return 'underway';
  if (completionPct < 90) return 'almostThere';
  return 'wrappingUp';
}

/** `GET /api/stories?epic_id=` 항목(core-storage `Story` 인터페이스 미러, 필요 필드만). */
export interface BeStoryListItem {
  id: string;
  epic_id: string | null;
  assignee_id: string | null;
}

export interface EpicCollaborator {
  id: string;
  name: string;
}

export interface EpicCollaboration {
  epicId: string;
  collaborators: EpicCollaborator[];
}

/**
 * 참여 = "붙어있나" 여부만(§5 하드라인) — 개수·처리량 절대 집계 안 함. 스토리를 배정자별로
 * 세지 않고 distinct assignee_id만 뽑아 "이 사람이 이 에픽에 함께 있다"만 표현.
 */
export function deriveCollaboration(
  epicIds: string[],
  stories: BeStoryListItem[],
  memberNames: Record<string, string>,
): EpicCollaboration[] {
  const storiesByEpic = new Map<string, BeStoryListItem[]>();
  for (const s of stories) {
    if (!s.epic_id) continue;
    const list = storiesByEpic.get(s.epic_id) ?? [];
    list.push(s);
    storiesByEpic.set(s.epic_id, list);
  }
  return epicIds.map((epicId) => {
    const list = storiesByEpic.get(epicId) ?? [];
    const ids = Array.from(new Set(list.map((s) => s.assignee_id).filter((id): id is string => !!id)));
    return { epicId, collaborators: ids.map((id) => ({ id, name: memberNames[id] ?? id })) };
  });
}

/** `GET /api/activity-logs` 항목(`dashboard-activity-timeline.tsx`의 로컬 인터페이스 미러). */
export interface BeActivityLogItem {
  id: string;
  actor_type: 'human' | 'agent' | null;
  action: string;
  entity_type: string | null;
  entity_title: string | null;
  created_at: string;
}

/**
 * "누가 주어인가" 리트머스(§6) — 이 리스트는 액터(누가 했나) 아닌 이벤트(무슨 일이 일어났나)가
 * 주어가 되도록 actor 정보를 아예 실어보내지 않는다(개인 미시활동 미노출). 마일스톤 관련
 * action만 허용목록(기존 `dashboard-activity-timeline`과 동일 집합 재사용 — 신규 action 문자열
 * 추정 안 함), 그 외는 무시(생동 스트림은 "일어난 일 중 의미 있는 것"만).
 */
const MILESTONE_ACTIONS = new Set([
  'story.status_changed',
  'story.created',
  'agent_run.completed',
  'agent_run.failed',
  'sprint.started',
  'sprint.closed',
  'doc.created',
]);

export function filterMilestoneEvents(items: BeActivityLogItem[]): BeActivityLogItem[] {
  return items.filter((i) => MILESTONE_ACTIONS.has(i.action));
}
