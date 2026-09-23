/**
 * story #4217(PO 결정) — 현재 주소를 **전체 문서 이동**으로 다시 연다(서버 레이아웃이 경로를 다시 해석하게). 셸이 scoped 경로의
 * 프로젝트를 클라이언트 스냅샷(멤버십)으로 못 풀 때 쓴다 — 드문 경로라 새로고침 한 번이 옛 프로젝트로 읽고 쓰는 것보다 싸다.
 * replace라 같은 주소가 방문 기록에 두 번 쌓이지 않는다. 테스트가 모킹할 수 있게 한 곳에 둔다.
 */
export function reopenCurrentUrl(): void {
  if (typeof window === 'undefined') return;
  window.location.replace(window.location.href);
}
