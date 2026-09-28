/**
 * [SID:4299] 첫 화면이 조용해진 뒤에 한 번 부른다 — 문서가 다 읽혔고(readyState complete) 새 자원 도착이 quietMs 동안 없을 때
 * (PerformanceObserver 'resource'), 늦어도 maxWaitMs. 쉬는 틈(requestIdleCallback — WKWebView엔 없어 setTimeout 폴백)에 run.
 *
 * 쓰임: 첫 화면 물결(/api · RSC)과 겹치지 않아도 되는 일(탭 프리패치 등)을 뒤로 미룬다 — 기기 콜드에서 탭 프리패치 11개가 물결 뒤
 * 정착을 +300ms 밀고 서버 RSC 렌더를 늘렸다(4299 AC3 판 · 2026-09-28).
 * 진행 중인 요청은 못 본다(끝난 자원만 보고됨) — «조용함»은 근사다. 돌려준 함수로 취소.
 */
export function whenFirstScreenQuiet(run: () => void, { quietMs = 1000, maxWaitMs = 10_000 } = {}): () => void {
  if (typeof window === 'undefined') return () => {};
  const start = performance.now();
  let last = start;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver(() => { last = performance.now(); });
    observer.observe({ type: 'resource', buffered: false });
  } catch {
    observer = undefined; // 관찰 불가 환경 — 문서 load + quietMs만으로 판단
  }
  const stop = () => {
    observer?.disconnect();
    if (timer !== undefined) clearTimeout(timer);
  };
  const tick = () => {
    const now = performance.now();
    const quiet = document.readyState === 'complete' && now - last >= quietMs;
    if (!quiet && now - start < maxWaitMs) {
      timer = setTimeout(tick, 250);
      return;
    }
    done = true;
    stop();
    const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => run(), { timeout: 2000 });
    else setTimeout(run, 0);
  };
  timer = setTimeout(tick, 250);
  return () => {
    if (done) return;
    done = true;
    stop();
  };
}
