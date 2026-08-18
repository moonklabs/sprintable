// 네이티브 셸(sprintable-mobile) ↔ 웹 브릿지 — 명시적 메시지 스키마만 쓴다(계약 doc:
// e-mobile-content-painted-contract). window.ReactNativeWebView는 네이티브 웹뷰 안에서만
// 존재하므로(브라우저 직접 접속 시 undefined) 항상 옵셔널 체이닝으로 다룬다.

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

// #2310: 이 화면의 첫 유의미한 페인트가 끝났음을 셸에 알린다 — 셸은 이 신호를 받을 때까지
// 스플래시를 유지한다(앱 쪽은 이미 배선 완료 · sprintable-mobile PR#62). 여러 번 불려도
// 무해(셸이 1회만 반응). 네이티브 셸 밖(일반 브라우저)에서는 조용히 아무 일도 안 한다.
export function notifyContentPainted() {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'content-painted' }));
}

// story #2766(레인 A) §A5 — 다운로드 버튼 환경 분기의 판별 신호. 레인 B(#2765)가 실제 브릿지
// 훅(다운로드/외부 열기 postMessage 왕복)을 구현하기 전까지는, 이 판별만으로 "RN 안이면 아직
// 다운로드 미지원(레인 B 대기)"을 정직 표시하는 데 쓴다 — 서버사이드(SSR)에서 호출하면 항상
// false(window 없음).
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ReactNativeWebView);
}
