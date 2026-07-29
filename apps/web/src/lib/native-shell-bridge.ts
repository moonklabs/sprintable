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
