/**
 * E-GLANCE C1 — "감시 아닌 신뢰" 현황판. UX handoff doc(`e-glance-glance-board-handoff`, 유나
 * 2026-07-10) §1 감시-게이트 리트머스: 주어=프로젝트/팀(개인 성적·순위·처리량 절대 노출 0).
 *
 * story #3710(2026-09-09, 페드루 PO 決) — 로드맵 아크(`RoadmapArc`/`scopeRoadmapEpics`/
 * `mergeRoadmap`/`BeEpicListItem`/`deriveRoadmapStatus`)는 여기서 걷어냈다. 이 파일들의
 * 유일 소비처였던 `load-glance-data.ts`의 에픽 fetch·로드맵 계산이 죽은 경로였다("갈래" 뷰는
 * 이제 `NextMakerScreen`이 `/api/goals`를 cursor 모드로 독립 로드해 그린다 — grep 전수: `flow-
 * client.tsx`는 `loadGlanceData` 결과 중 `attentionSignals`·`memberMap`만 소비, roadmap은
 * 소비 0). story #4062 후속(같은 날, 페드루 PO 決) — `RoadmapStatus`·`RoadmapEpic`도 마저
 * 걷어냈다: 마지막 소비처였던 `derive-flow.ts`의 `deriveFlowLaneRows`가 그 사이 삭제되며
 * (유일 소비처 FlowLane 은퇴) 방금 소비처 0이 됐다 — 남기면 "살아 있는 추상". `BeFocalStory`
 * (→`derive-hero-envelope.ts`)는 여전히 실 소비처가 있어 남겨 둔다.
 */

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
