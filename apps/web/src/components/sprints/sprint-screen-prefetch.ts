/**
 * story #4328 — 스프린트 화면 첫 물결 선출발: 스프린트 목록 + 「하루 체크인」(embedded 스탠드업) 요청 여섯.
 *
 * 왜: 스프린트 화면이 API를 **세 물결**로 차례차례 기다렸다(배포 30 · 보드 → 스프린트 정착 1.6~2.5초).
 *   1. `/api/sprints` — 스프린트 목록이 오기 전엔 화면이 스켈레톤만 그려 스탠드업 절이 **마운트조차 안 됐다**.
 *   2. 스탠드업 절이 붙어서야 스탠드업 · 구성원 · 스탠드업 기록.
 *   3. 그 둘을 **기다린 뒤에야** 활성 스프린트 · 피드백 · 미작성 — 셋 다 앞 결과가 필요 없는데(프로젝트 · 날짜만) 코드 순서로 뒤에 있었다.
 * 처방: 스프린트 목록과 스탠드업이 첫 화면에서 쓰는 요청 여섯을 **한 물결**로 — 로딩 경계가 뜨는 순간(누른 즉시) 일곱을 다 출발시키고, 화면은
 * 붙을 때 그 응답을 한 번 넘겨받는다(규칙은 `lib/response-prefetch`). 목록도 넣는 까닭: 목록 요청은 화면(SprintsClient)이 마운트돼야 나가는데,
 * 화면은 서버 페이지 응답을 기다린다 — 차가운 첫 판(1440)에 목록이 1.1초 뒤에야 출발해 물결이 둘로 갈렸다(실측).
 * 남는 진짜 의존: 활성 스프린트 id가 있어야 스프린트 스토리 · 그 스토리의 작업 수.
 */
import { formatSeoulDate } from '@/lib/date';
import { createResponsePrefetch } from '@/lib/response-prefetch';

export const SPRINT_SCREEN_PREFETCH_TTL_MS = 10_000;

export interface SprintScreenPrefetchScope {
  memberId: string | null | undefined;
  projectId: string | null | undefined;
}

/** 화면(standup-client · standup-history-section)과 선출발이 **같은 주소**를 만들어야 넘겨받기가 맞는다 — 주소는 여기서만 만든다. */
export const sprintScreenUrls = {
  sprintList: (projectId: string) => `/api/sprints?project_id=${projectId}`,
  entries: (date: string) => `/api/standup?date=${date}`,
  members: () => '/api/team-members',
  activeSprints: (projectId: string) => `/api/sprints?project_id=${projectId}&status=active`,
  feedback: (projectId: string, date: string) => `/api/standup/feedback?project_id=${projectId}&date=${date}`,
  missing: (projectId: string, date: string) => `/api/standup/missing?project_id=${projectId}&date=${date}`,
  history: (projectId: string) => `/api/standup/history?project_id=${projectId}&limit=20`,
};

const store = createResponsePrefetch(SPRINT_SCREEN_PREFETCH_TTL_MS);
const scopeKeyOf = (scope: SprintScreenPrefetchScope) => `${scope.memberId ?? ''}|${scope.projectId ?? ''}`;

/** 스프린트 로딩 경계 · 스프린트 화면 마운트에서 부른다(목록 + 스탠드업 여섯)(오늘 날짜 — 스탠드업 절의 첫 날짜와 같은 `formatSeoulDate()`). */
export function prefetchSprintScreen(scope: SprintScreenPrefetchScope, date: string = formatSeoulDate(), now: number = Date.now()): void {
  if (!scope.projectId) return; // 스탠드업 절은 프로젝트 안에서만 붙는다.
  const key = scopeKeyOf(scope);
  store.start(sprintScreenUrls.sprintList(scope.projectId), key, now);
  store.start(sprintScreenUrls.entries(date), key, now);
  store.start(sprintScreenUrls.members(), key, now);
  store.start(sprintScreenUrls.activeSprints(scope.projectId), key, now);
  store.start(sprintScreenUrls.feedback(scope.projectId, date), key, now);
  store.start(sprintScreenUrls.missing(scope.projectId, date), key, now);
  store.start(sprintScreenUrls.history(scope.projectId), key, now);
}

/** 선출발한 같은 요청이 규칙(1회용 · 기한 · 범위)에 맞으면 그 응답을, 아니면 새로 요청한다. */
export function takeSprintScreenOrFetch(url: string, scope: SprintScreenPrefetchScope, now: number = Date.now()): Promise<Response> {
  return store.take(url, scopeKeyOf(scope), now);
}

/** 테스트 전용. */
export function __resetSprintScreenPrefetchForTest(): void {
  store.reset();
}
