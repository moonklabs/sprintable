/**
 * E-GLANCE C1 — "감시 아닌 신뢰" 현황판. UX handoff doc(`e-glance-glance-board-handoff`, 유나
 * 2026-07-10) §1 감시-게이트 리트머스: 주어=프로젝트/팀(개인 성적·순위·처리량 절대 노출 0).
 *
 * 데이터 소스는 전부 실 확인(grounding, 추정 0):
 * - 로드맵 순서: `GET /api/goals?project_id=`(created_at asc) — 에픽에 전용 큐 순서 컬럼 없음
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

/** story #2298/#2303 — `?include=glance` 옵트인 시 `focal_story`에 실리는 9필드. `/api/glance/hero?story_id=`
 * 전체 웨이브를 대체(#2303 그라운딩: glance-hero.tsx + 호출체인이 실제로 읽는 필드만 — description·
 * envelope.claim/status·gate.status/decision_basis/auto_decision_reason·human_verified_by.member_id/role·
 * gates 전체배열은 화면이 안 읽어 의도적으로 뺐다). */
export interface BeFocalStory {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  assignee_ids: string[];
  proof_count: number;
  auto_verify: 'passed' | 'failed' | null;
  gate: { gate_type: string; requires_human: boolean } | null;
  trust: {
    self_reported: boolean;
    human_verified: boolean;
    human_verified_by: { name: string } | null;
    human_verified_at: string | null;
  };
}

/** `GET /api/goals` 응답 항목(core-storage `Epic` 인터페이스 미러, 필요 필드만). */
export interface BeEpicListItem {
  id: string;
  title: string;
  status: string;
  created_at: string;
  // story #2341 AC2 — `GoalResponse.updated_at`(backend/app/schemas/goal.py:96, `GoalWithGlanceResponse`가
  // 상속하므로 `?include=glance` 응답에도 항상 실린다, git blame 6462ad1af4·2026-04-29부터 계약에
  // 존재)를 tie-break 재료로 노출. load-glance-data.ts가 "active 에픽 52개 중 먼저 오는 하나"
  // 문제를 이 필드로 좁힌다(#2341 AC1의 근본 방향(㉡ active를 파생값化)과는 별개 — 그게 오기
  // 전까지의 완화).
  updated_at: string;
  // E-GLANCE wedge #2(로드맵 조타): 큐레이션 순서(null=미조타). 아크는 이 순서를 소비만 한다
  // (드래그 없음). BE order_by=position 미지정/미보유 시 전부 null 취급 → 기존 created_at 정렬과
  // 동일(#2056 회귀0).
  position?: number | null;
  // story #2298(3단 웨이터폴 근절) — `?include=glance` 옵트인일 때만 실린다(미지정 시 undefined,
  // BE byte-identical 계약 그대로). participant_ids: 이 에픽의 고유 assignee_id 집합(캡 없음).
  participant_ids?: string[];
  focal_story?: BeFocalStory | null;
}

/**
 * "현재 궤적"(current-arc) window — 유나 로드맵 서사 확定안 (b), 2026-07-10. 이 프로젝트는
 * 실제로 에픽 100개+(수년 백로그 히스토리)를 갖고 있어 `/api/goals`를 그대로 로드맵에 넣으면
 * "6개 마일스톤" 서사(목업)와 완전히 어긋나고, 에픽 수만큼 `/api/stories?epic_id=`를 병렬
 * fetch하는 구조가 돼 규모가 커질수록 레이스/성능 문제까지 만든다(라이브 확認 中 발견).
 *
 * 신규 큐레이션 필드(태그 등) 없이 **기존 `epic.status` + created_at 순서만으로 도출**:
 * active 에픽(들)을 anchor("● 여기")로 삼아 그 앞뒤로 소수만 window — 최근 완료(behind)·
 * active 클러스터·다음 예정(ahead). active가 0개면 done/archived→draft 경계를 anchor로.
 * 나머지는 이 window 밖(§9 "지난 여정" — 별도 온디맨드 UI는 후속, 지금은 생략만).
 */
const DEFAULT_ARC_WINDOW = { behind: 2, ahead: 2, bound: 8 } as const;

export interface RoadmapArc {
  epics: BeEpicListItem[];
  totalCount: number;
}

export function scopeRoadmapEpics(
  epics: BeEpicListItem[],
  window: { behind: number; ahead: number; bound: number } = DEFAULT_ARC_WINDOW,
): RoadmapArc {
  // 큐레이션(position≠null) 우선(position ASC) → 나머지는 created_at ASC(아크의 과거→현재
  // 시간 읽기 유지). BE order_by=position((position IS NULL) ASC, position ASC, created_at DESC)의
  // curated-first를 아크가 소비만 반영 — 조타 결과가 로드맵 아크에도 비친다(wedge #2·소비 전용).
  // position 전무 시(미조타) 전부 created_at ASC로 폴백 → 기존 렌더 100% 동일(#2056 회귀0).
  const asc = [...epics].sort((a, b) => {
    const ap = a.position;
    const bp = b.position;
    if (ap != null && bp != null) return ap - bp;
    if (ap != null) return -1;
    if (bp != null) return 1;
    return a.created_at.localeCompare(b.created_at);
  });
  const activeIndices: number[] = [];
  for (let i = 0; i < asc.length; i++) if (asc[i]!.status === 'active') activeIndices.push(i);

  let start: number;
  let end: number;
  if (activeIndices.length > 0) {
    start = Math.max(0, Math.min(...activeIndices) - window.behind);
    end = Math.min(asc.length, Math.max(...activeIndices) + 1 + window.ahead);
  } else {
    // active 0개 — 최근 완료(done/archived)의 끝과 다음 예정(draft)의 시작 사이를 anchor로.
    let lastDoneIdx = -1;
    for (let i = 0; i < asc.length; i++) if (asc[i]!.status === 'done' || asc[i]!.status === 'archived') lastDoneIdx = i;
    const firstDraftIdx = asc.findIndex((e) => e.status === 'draft');
    const anchor = lastDoneIdx >= 0 ? lastDoneIdx : (firstDraftIdx >= 0 ? firstDraftIdx : 0);
    start = Math.max(0, anchor - window.behind + 1);
    end = Math.min(asc.length, anchor + 1 + window.ahead);
  }

  // 라이브 픽셀(2026-07-11) 적출 — active 클러스터가 넓게 퍼지면(behind~ahead 폭이 bound를
  // 초과) 무조건 slice(0, bound)로 잘라내던 게 "가장 오래된 bound개"(대부분 done/archived)만
  // 취해버려 "현재 궤적" 서사가 깨졌다. 잘라낼 땐 항상 뒤쪽(최신·anchor+ahead 방향)을 우선
  // 남긴다 — "지금부터"(forward) 프레이밍과 정합.
  if (end - start > window.bound) start = end - window.bound;
  const windowed = asc.slice(start, end);
  return { epics: windowed, totalCount: asc.length };
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

// story #2224(선생님 정정 2026-07-30) — EpicCollaborator/EpicCollaboration(협업맵)·
// BeActivityLogItem/filterMilestoneEvents(생동 스트림)·VagueRecency/deriveVagueRecency(§④
// 성긴 시각 버킷)를 삭제했다. 유일 소비처였던 `CollaborationMap`·`LiveStream`이 `/glance`
// 삭제와 함께 죽은 코드였다(grep 전수 확認 — 사용처 0). `ProgressTrajectory`(§4, 진짜
// "진행 궤적" — 이 이름 그대로)도 같은 감사에서 죽은 코드로 확認돼 함께 삭제했다.
