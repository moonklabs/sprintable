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

// story #2766(레인 A) §A5 — 다운로드 버튼 환경 분기의 판별 신호. 서버사이드(SSR)에서
// 호출하면 항상 false(window 없음).
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ReactNativeWebView);
}

// story #2765(레인 B) §2 — 웹↔셸 postMessage 계약. content-painted와 동일한 명시 스키마
// 관례(sprintable-mobile App.js:746 onMessage의 type 스위치가 소비). url은 항상
// disposition=attachment(다운로드) 또는 inline(외부 열기) 서명 URL — 단명이라 호출 직전에
// 새로 발급한 것만 넘긴다(캐시된 URL 재사용 금지).
function downloadViaShell(url: string, filename: string) {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'download', url, filename }));
}

function openExternalViaShell(url: string) {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'open-external', url }));
}

/**
 * 환경 분기 훅(레인 A가 호출) — RN 셸 안이면 postMessage로 위임(레인 B가 실제 저장/공유를
 * 수행), 일반 브라우저면 기존 `<a download>` 경로 그대로(회귀 0).
 */
export function downloadAsset(url: string, filename: string) {
  if (isNativeShell()) {
    downloadViaShell(url, filename);
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function openExternal(url: string) {
  if (isNativeShell()) {
    openExternalViaShell(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
