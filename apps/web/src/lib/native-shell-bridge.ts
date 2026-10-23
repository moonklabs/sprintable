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
    __SPRINTABLE_SHELL__?: { platform: 'ios' | 'android' | 'macos'; pushRegister?: unknown };
  }
}

// #2310: 이 화면의 첫 유의미한 페인트가 끝났음을 셸에 알린다 — 셸은 이 신호를 받을 때까지
// 스플래시를 유지한다(앱 쪽은 이미 배선 완료 · sprintable-mobile PR#62). 네이티브 셸
// 밖(일반 브라우저)에서는 조용히 아무 일도 안 한다.
// story #4168 — 페이지 로드당 최대 1회만 보낸다(모듈 상태는 전체 새로고침 때만 초기화된다).
let contentPaintedSent = false;

export function notifyContentPainted() {
  if (contentPaintedSent) return;
  const bridge = window.ReactNativeWebView;
  if (!bridge) return;
  contentPaintedSent = true;
  bridge.postMessage(JSON.stringify({ type: 'content-painted' }));
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

// story #4397 — the active account changed without passing /login (account switch · «log out only this account» with another
// account left). The shell re-registers its push device so the device follows the new person (the register upsert
// overwrites user · org · member). Not `session-changed`: that one is the cookie flush on every token refresh. Same
// convention as the others — outside the native shell it does nothing.
export function notifyAccountChanged() {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'account-changed' }));
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

// story #4694 AC2 ② — the phone's «this phone could not be registered for notifications» state. The shell (sprintable-mobile
// App.js · lib/pushRetry.js) merges `pushRegister` into `window.__SPRINTABLE_SHELL__` and fires `sprintable-shell-push` whenever it changes
// (after every retry too, even when the state is the same). Shape is closed: anything else reads as «nothing to show» (a wrong «notifications are
// off» is worse than no line). Outside the native shell it is always null. The raw error code never reaches the web — two causes only.
// `register` (the server refused the registration) is accepted for when the shell starts reporting it; today the shell sends the three token-side stages.
export type PushRegisterFailed = { state: 'failed'; stage: 'permission' | 'device_token' | 'expo_token' | 'register'; cause: 'permission' | 'other'; retried: boolean };

export const PUSH_REGISTER_EVENT = 'sprintable-shell-push';
const PUSH_STAGES = ['permission', 'device_token', 'expo_token', 'register'];

export function readPushRegisterFailure(): PushRegisterFailed | null {
  if (typeof window === 'undefined' || !window.ReactNativeWebView) return null;
  const v = window.__SPRINTABLE_SHELL__?.pushRegister as Partial<PushRegisterFailed> | undefined;
  if (!v || typeof v !== 'object' || v.state !== 'failed') return null;
  if (typeof v.stage !== 'string' || !PUSH_STAGES.includes(v.stage)) return null;
  if (v.cause !== 'permission' && v.cause !== 'other') return null;
  if (typeof v.retried !== 'boolean') return null;
  return { state: 'failed', stage: v.stage as PushRegisterFailed['stage'], cause: v.cause, retried: v.retried };
}

// «registering…» lives here, not in the component: Settings tabs unmount their content, and a person who switches tabs during a slow
// retry must come back to the same «registering…» (the shell may still be busy and would ignore a second message). One press = one message.
// The shell answers every attempt with the event; if it never does (webview paused) the pending state gives up so the button is not off for ever.
const RETRY_GIVE_UP_MS = 20_000; // longer than the shell's own attempt (a few seconds) · short enough that a stale «registering…» (a client-side sign-out → sign-in that keeps this module) clears itself
let retryPending = false;
let retryGiveUp: ReturnType<typeof setTimeout> | null = null;
// the one-shot listener that ends «pending» when nobody is subscribed (panel unmounted) — removed on every way out, so repeated give-ups never pile listeners up
let retryAnswerListener: (() => void) | null = null;
const changeListeners = new Set<() => void>();
const emitChange = () => changeListeners.forEach((l) => l());

function endRetryPending() {
  retryPending = false;
  if (retryGiveUp) { clearTimeout(retryGiveUp); retryGiveUp = null; }
  if (retryAnswerListener) { window.removeEventListener(PUSH_REGISTER_EVENT, retryAnswerListener); retryAnswerListener = null; }
}

export function isPushRetryPending(): boolean {
  return retryPending;
}

export function subscribePushRegister(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onShell = () => { endRetryPending(); onChange(); };
  changeListeners.add(onChange);
  window.addEventListener(PUSH_REGISTER_EVENT, onShell);
  return () => {
    changeListeners.delete(onChange);
    window.removeEventListener(PUSH_REGISTER_EVENT, onShell);
  };
}

// «다시 시도» — one closed message; the shell answers with a new `sprintable-shell-push` event when the attempt is over.
// Fail closed: outside the shell → nothing is sent and nothing goes pending; a bridge whose postMessage is missing or throws leaves nothing pending either.
export function requestPushRetry() {
  if (typeof window === 'undefined' || retryPending) return;
  const bridge = window.ReactNativeWebView;
  if (!bridge) return;
  retryPending = true;
  retryGiveUp = setTimeout(() => { endRetryPending(); emitChange(); }, RETRY_GIVE_UP_MS);
  // the shell's answer ends the pending state even when nobody is subscribed (the Settings panel unmounted meanwhile)
  retryAnswerListener = endRetryPending;
  window.addEventListener(PUSH_REGISTER_EVENT, retryAnswerListener);
  try {
    bridge.postMessage(JSON.stringify({ type: 'push-retry' }));
  } catch {
    endRetryPending();
  }
  emitChange();
}
