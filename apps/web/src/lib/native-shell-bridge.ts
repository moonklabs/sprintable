// 네이티브 셸(sprintable-mobile) ↔ 웹 브릿지 — 명시적 메시지 스키마만 쓴다(계약 doc:
// e-mobile-content-painted-contract). window.ReactNativeWebView는 네이티브 웹뷰 안에서만
// 존재하므로(브라우저 직접 접속 시 undefined) 항상 옵셔널 체이닝으로 다룬다.

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    // story #3118(Sign in with Apple, AC0) — ReactNativeWebView와 별개 이름공간(민군
    // 정렬 済, sprintable-mobile 배선). ReactNativeWebView는 iOS·안드로이드 양쪽에
    // react-native-webview가 동형으로 주입해 플랫폼 구분 신호가 못 된다 — 이 전역이
    // "무엇인지"(셸의 진실)를 말하고, 웹은 "보여줄지"(AC0 노출 정책)만 판단한다. 셸은
    // Android도 숨기지 않고 참값을 넣는다(injectedJavaScriptBeforeContentLoaded/Tauri
    // initialization_script — hydrate 전 값이 서 있어야 fail-closed가 실제로 안전).
    __SPRINTABLE_SHELL__?: { platform: 'ios' | 'android' | 'macos' };
  }
}

// #2310: 이 화면의 첫 유의미한 페인트가 끝났음을 셸에 알린다 — 셸은 이 신호를 받을 때까지
// 스플래시를 유지한다(앱 쪽은 이미 배선 완료 · sprintable-mobile PR#62). 여러 번 불려도
// 무해(셸이 1회만 반응). 네이티브 셸 밖(일반 브라우저)에서는 조용히 아무 일도 안 한다.
export function notifyContentPainted() {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'content-painted' }));
}

// story #3302(#2459 진단 (c) 갈래) — 브릿지 계약의 발신 절반. 셸(sprintable-mobile App.js:370
// AppState 백그라운드 flush + :798 session-changed flush)은 2026-07-21 P0 대응으로 이미
// 배선됐으나, 웹이 이 신호를 한 번도 보낸 적이 없었다(그 사이 grep 0건). 로그인·세션 회전·
// 갱신 직후 호출하면 셸이 즉시 쿠키를 디스크로 내려(그 전엔 백그라운드 진입 때까지 대기 —
// "포그라운드 유지한 채 바로 강제종료"하는 경우를 못 잡던 그 창을 닫는다). content-painted와
// 동일 관례 — 네이티브 셸 밖에서는 조용히 아무 일도 안 한다.
export function notifySessionChanged() {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'session-changed' }));
}

// story #2766(레인 A) §A5 — 다운로드 버튼 환경 분기의 판별 신호. 서버사이드(SSR)에서
// 호출하면 항상 false(window 없음).
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ReactNativeWebView);
}

// story #3118 AC0(선생님 확定 2026-08-26) — Apple 로그인은 iOS·macOS 셸에서만 노출,
// 웹·안드로이드는 없어야 한다. 신호 부재·위조(3값 밖 문자열 등)는 전부 비노출로 떨어지는
// fail-closed — `platform`이 정확히 'ios'|'macos' 둘 중 하나일 때만 true. SSR에서는 항상
// false(window 없음 — 로그인 페이지는 'use client'라 하이드레이션 후 재평가된다).
export function isAppleLoginEligible(): boolean {
  const platform = typeof window !== 'undefined' ? window.__SPRINTABLE_SHELL__?.platform : undefined;
  return platform === 'ios' || platform === 'macos';
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
