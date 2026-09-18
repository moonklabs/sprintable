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
 * (유일 소비처 FlowLane 은퇴) 방금 소비처 0이 됐다 — 남기면 "살아 있는 추상". story #3715
 * 후속(같은 grep 스윕, 페드루 PO 決) — `BeFocalStory`도 마저 걷어냈다: 그때는 실 소비처로
 * 남겨 둔 `derive-hero-envelope.ts`가 유일 소비처였던 glance-hero.tsx와 함께 #3715에서
 * 삭제되며 방금 소비처 0이 됐다(같은 클래스 재발 — "여전히 산다"고 적어 둔 바로 다음
 * 라운드에 죽는 사례, 판정은 항상 grep 재확認 시점 기준).
 */

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
