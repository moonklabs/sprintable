/**
 * story #2642 — 엔티티 칩 「전체 보기」가 뷰어의 현재 프로젝트로 착지하던 결함(다른 프로젝트
 * 엔티티는 오정보/404)의 공통 처방. #2168(doc, doc-project-url.ts::docViewUrl)이 이미 증명한
 * 패턴을 story/epic/sprint/asset(own-href)·task/evidence/artifact(via-parent)로 동형 확장한다
 * — 엔티티 자신(또는 via-parent면 그 부모)이 속한 project의 org_slug/project_slug를 클릭
 * 시점에 선조회해 `/{ws}/{proj}/{resource}...`로 직행, proxy.ts::redirectLegacyResourcePath의
 * "뷰어의 현재 프로젝트 디폴트" 추측을 거치지 않는다.
 *
 * PO 08-14 확定 4조건:
 * ① 스코프=동일 org·교차 project만(크로스 org는 명시 제외 — 별도 축).
 * ② 처방=#2168 패턴 동형(own-href 자기 선조회·via-parent는 부모 기준).
 * ③ 해석 시점=클릭 시점(모달 오픈 useEffect) 유지 — 렌더(칩 목록) 시점 선조회로 바꾸지
 *    않는다(N+1 팬아웃 방지).
 * ④ 폴백=현행 bare 경로(선조회 실패/project_slug 없음 시 더 나빠지지 않는다).
 */

/** DocPreviewResponse(#2168)와 동형 계약 — BE가 org_slug/project_slug를 additive로 얹어주는
 * 모든 엔티티 preview/detail 응답이 이 shape를 따른다. project_slug는 nullable(Project.slug가
 * nullable — 옛 미백필 프로젝트). */
export interface EntityProjectSlugs {
  orgSlug: string;
  projectSlug: string | null;
}

/**
 * 선조회 결과와 순수 문자열 폴백을 받아, 스코프드 URL을 만들 수 있으면 만들고 아니면 폴백을
 * 그대로 준다(④ 폴백 원칙). `orgSlug`가 빈 문자열이거나 `projectSlug`가 null이면 스코프드
 * URL을 지을 재료가 부족하다는 뜻이라 폴백으로 떨어진다(예: project.slug 미백필).
 */
export function resolveScopedEntityHref(
  slugs: EntityProjectSlugs | null,
  bareFallback: string | null,
  buildScoped: (wsSlug: string, projSlug: string) => string,
): string | null {
  if (slugs?.orgSlug && slugs.projectSlug) {
    return buildScoped(slugs.orgSlug, slugs.projectSlug);
  }
  return bareFallback;
}

/** story 착지 — next.config.ts의 `/:ws/:proj/board→/:ws/:proj/flow?view=list` redirects()가
 * `?story=`를 자동 병합한다(story #2224 실측 확認·comment) — 이 함수는 그 리네이밍 관심사와
 * 결합하지 않고 `/board`만 짓는다(IA 이름이 또 바뀌어도 이 파일은 안 바뀐다). */
export function storyBoardUrl(wsSlug: string, projSlug: string, storyId: string): string {
  return `/${wsSlug}/${projSlug}/board?story=${storyId}`;
}

/** epic(목표) 착지 — `[ws]/[proj]/goals/[id]/page.tsx` 경로 파라미터. */
export function goalUrl(wsSlug: string, projSlug: string, epicId: string): string {
  return `/${wsSlug}/${projSlug}/goals/${epicId}`;
}

/** sprint 착지 — `[ws]/[proj]/sprints/sprints-client.tsx`가 `?id=`로 자동선택한다(딥링크). */
export function sprintUrl(wsSlug: string, projSlug: string, sprintId: string): string {
  return `/${wsSlug}/${projSlug}/sprints?id=${sprintId}`;
}

/** asset 착지 — `[ws]/[proj]/storage/storage-view.tsx`가 `?asset=`으로 자동선택한다(딥링크,
 * story #2302). */
export function assetStorageUrl(wsSlug: string, projSlug: string, assetId: string): string {
  return `/${wsSlug}/${projSlug}/storage?asset=${assetId}`;
}
