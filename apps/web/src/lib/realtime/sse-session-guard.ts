'use client';

import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #2160 — EventSource가 readyState=CLOSED(2)로 error를 내는 것은 스펙상 "복구 불가"
 * 판정이다(non-2xx 응답이거나 content-type 불일치면 브라우저가 자동재연결을 포기하고 CLOSED로
 * 고정한다 — 실측: 401 응답 시 Chromium이 error 이벤트 정확히 1회만 내고 재연결하지 않음).
 * 그런데 EventSource는 실패 사유(상태코드)를 노출하지 않아, 이 신호만으로는 "세션이 죽었다"와
 * "업스트림이 한 번 삐끗했다"를 못 가른다. fetchWithAuth('/api/me')로 실제 세션 상태를 물어
 * 가른다 — 401→refresh 시도→(실패 시)signalSessionExpired 가 이미 내장돼 있다(발명 0).
 */
// story #4184(배포 18 라이브 PO CDP) — /chats → /settings 하드 이동에서 떠나는 페이지의 EventSource가 이동 때문에
// 끊기며 CLOSED error를 내고, 그 onerror가 이 함수로 `/api/me`를 한 번 더 불렀다(서버 쪽 SSE 실패가 아니다 —
// event-stream은 200). 페이지를 떠나는 중에 난 오류는 세션 문제가 아니므로 묻지 않는다.
// - beforeunload(이동 시작)·pagehide(언로드)에서 표시하고, pageshow(뒤로 가기 캐시 복귀)에서 푼다.
// - beforeunload가 취소돼 페이지에 남는 경우를 위해 표시는 UNLOAD_GRACE_MS 뒤 저절로 풀린다 — 그 뒤 진짜 만료는
//   원래대로 잡는다(풀린 뒤 늦게 도착한 이동 오류는 `/api/me` 한 번이 더 나갈 뿐 정확성 문제는 없다).
const UNLOAD_GRACE_MS = 5000;
let leavingPage = false;
let leavingTimer: ReturnType<typeof setTimeout> | null = null;

function markLeaving(): void {
  leavingPage = true;
  if (leavingTimer) clearTimeout(leavingTimer);
  leavingTimer = setTimeout(() => { leavingPage = false; leavingTimer = null; }, UNLOAD_GRACE_MS);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', markLeaving);
  window.addEventListener('pagehide', markLeaving);
  window.addEventListener('pageshow', () => {
    leavingPage = false;
    if (leavingTimer) { clearTimeout(leavingTimer); leavingTimer = null; }
  });
}

/** 테스트 전용 — 페이지 이탈 표시 상태를 초기화한다. */
export function resetLeavingPageForTest(): void {
  leavingPage = false;
  if (leavingTimer) { clearTimeout(leavingTimer); leavingTimer = null; }
}

export async function isSessionAlive(): Promise<boolean> {
  // 떠나는 페이지의 연결이 이동 때문에 끊긴 것 — 세션을 묻지 않는다(재시도도 이 페이지에선 의미 없다).
  if (leavingPage) return true;
  try {
    return (await fetchWithAuth('/api/me')).ok;
  } catch {
    // 네트워크 자체 문제(오프라인 등)는 세션 문제로 오판하지 않고 기존 백오프 재시도에 맡긴다.
    return true;
  }
}
