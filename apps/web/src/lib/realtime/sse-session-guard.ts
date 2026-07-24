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
export async function isSessionAlive(): Promise<boolean> {
  try {
    return (await fetchWithAuth('/api/me')).ok;
  } catch {
    // 네트워크 자체 문제(오프라인 등)는 세션 문제로 오판하지 않고 기존 백오프 재시도에 맡긴다.
    return true;
  }
}
