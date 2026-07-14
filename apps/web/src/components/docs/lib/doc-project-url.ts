/**
 * prod P0(2026-07-14) — `?p=`(useProjectSsot의 탭별 SSOT)를 안 실은 채 `/docs/*`로 push하면
 * urlProjectId가 없다고 판단한 자가치유 effect가 fallback 체인(sessionStorage→serverProjectId)을
 * 다시 태운다. 그 fallback이 지금 이 탭이 실제로 쓰던 project와 항상 같다는 보장이 없어
 * (특히 org 전환 직후 — accessibleIds가 서버 prop 기반이라 새 project를 아직 못 담고 있을 수
 * 있음), 방금 만든/보던 문서와 다른 project로 재질의돼 "문서를 찾을 수 없습니다"에 빠질 수
 * 있다(dev 크로스-org 전환으로 라이브 재현 완료). 두 호출부(신규 문서 생성 이동·not-found
 * 회복 이동) 모두 `?p=`를 명시해 이 fallback 자체가 발동하지 않게 한다 — 순수 함수로 뽑아
 * 두 지점에서 동일 규약을 강제하고 단위 테스트로 직접 검증한다.
 */
export function newDocUrl(slug: string, projectId: string): string {
  return `/docs/${slug}?new=1&p=${projectId}`;
}

export function docsListUrl(projectId: string): string {
  return `/docs?p=${projectId}`;
}
