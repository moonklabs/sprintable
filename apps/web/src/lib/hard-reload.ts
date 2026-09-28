/**
 * story #4217(PO 결정) — 현재 주소를 **전체 문서 이동**으로 다시 연다(서버 레이아웃이 경로를 다시 해석하게). 셸이 scoped 경로의
 * 프로젝트를 클라이언트 스냅샷(멤버십)으로 못 풀 때 쓴다 — 드문 경로라 새로고침 한 번이 옛 프로젝트로 읽고 쓰는 것보다 싸다.
 * - replace라 같은 주소가 방문 기록에 두 번 쌓이지 않는다.
 * - **같은 주소는 1회만**(PO 무한 새로고침 위험): 다시 열어도 못 푸는 경우(멤버십 조회 실패 등)엔 두 번째부터 이동하지 않고
 *   false를 돌려준다 — 셸은 헤더 0 · 페이지 미마운트로 머문다. 풀리면 `clearReopenMarker()`로 표지를 지워 다음 번엔 다시 1회.
 * 저장소가 막혀도(사생활 모드 등) 이동하지 않는 쪽(false)으로 — 루프보다 멈춤이 안전.
 */
const REOPEN_MARKER_KEY = 'sp_reopen_once_url';

export function reopenCurrentUrlOnce(navigate: (url: string) => void = (url) => window.location.replace(url)): boolean {
  if (typeof window === 'undefined') return false;
  const href = window.location.href;
  try {
    if (window.sessionStorage.getItem(REOPEN_MARKER_KEY) === href) return false;
    window.sessionStorage.setItem(REOPEN_MARKER_KEY, href);
  } catch {
    return false;
  }
  navigate(href);
  return true;
}

export function clearReopenMarker(): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(REOPEN_MARKER_KEY); } catch { /* 저장소 막힘 — 표지도 없다 */ }
}

/**
 * 사람이 누른 «다시 시도» — 루프 위험이 없으니 표지 기록 성공 여부와 상관없이 **무조건** 전체 이동한다(PO). 저장소가 막힌
 * 브라우저에선 `reopenCurrentUrlOnce`가 이동 없이 false라, 그 함수만 부르면 버튼을 눌러도 아무 일이 안 일어났다.
 * 저장소가 되면 표지를 새로 남겨(다시 열어도 못 풀면 다시 오류 상태 — 자동 루프 0).
 */
export function retryReopenCurrentUrl(navigate: (url: string) => void = (url) => window.location.replace(url)): void {
  if (typeof window === 'undefined') return;
  clearReopenMarker();
  if (!reopenCurrentUrlOnce(navigate)) navigate(window.location.href);
}
