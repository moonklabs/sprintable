/**
 * story a539c649(S-route-project) S2 — docs 는 이제 `/{ws}/{proj}/docs/...` path 위계로 산다.
 * ws/proj 가 path 세그먼트에 항상 박혀있으므로, prod P0(2026-07-14)가 고치던 문제(`?p=`
 * 누락 시 자가치유 effect 가 잘못된 project 로 재질의)는 **이 함수들이 `?p=` 를 실을 필요
 * 자체가 없어짐으로써 구조적으로 소거**된다 — #2154 회복 가드(a78a2b7e)를 이 슬라이스가
 * 흡수한다(별도 fallback 로직 불요, path 자체가 유일한 project 컨텍스트 출처).
 */
export function newDocUrl(wsSlug: string, projSlug: string, slug: string): string {
  return `/${wsSlug}/${projSlug}/docs/${slug}?new=1`;
}

/** 트리에서 기존 문서를 선택할 때 — newDocUrl과 달리 `new=1`(자동 포커스 트리거)을 안 싣는다. */
export function docUrl(wsSlug: string, projSlug: string, slug: string): string {
  return `/${wsSlug}/${projSlug}/docs/${slug}`;
}

export function docsListUrl(wsSlug: string, projSlug: string): string {
  return `/${wsSlug}/${projSlug}/docs`;
}
