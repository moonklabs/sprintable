// AC3(af8d3641): 세션-만료 모듈 신호. fetchWithAuth(비-React 모듈 함수)가 refresh 최종 실패 시
// bare `window.location.href` 대신 이 신호를 쏴 SessionExpiredDialog(React)를 띄운다. 동시 다중 401 은
// **dedupe**(signaled 플래그) — 한 번만 모달을 연다.

type Listener = () => void;

let listener: Listener | null = null;
let signaled = false;

/** SessionExpiredDialog 가 마운트 시 구독. cleanup 반환. */
export function subscribeSessionExpired(cb: Listener): () => void {
  listener = cb;
  return () => { if (listener === cb) listener = null; };
}

/** 세션 만료 신호(다중 호출은 1회로 dedupe). */
export function signalSessionExpired(): void {
  if (signaled) return;
  signaled = true;
  listener?.();
}

/** 재로그인 등으로 상태 초기화(다음 만료를 다시 잡도록). */
export function resetSessionExpired(): void {
  signaled = false;
}
