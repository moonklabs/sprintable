// OB-4 온보딩 funnel 측정 emit (계약 `ob-4-onboarding-funnel-measurement-contract` v1.2).
// FE 분담 4종만 emit. 레일 표시(OB-2)와는 분리된 vocab. emit은 non-blocking·fail-silent —
// 측정 실패가 wizard UX를 절대 막지 않는다.

const SESSION_KEY = 'sprintable_onboarding_session_id';

export type OnboardingEvent =
  | 'onboarding_started'
  | 'config_copied'
  | 'verify_started'
  | 'abandoned_explicit';

interface EventPayload {
  agent_id?: string | null;
  runtime?: string;
  failure_reason?: string;
}

/**
 * wizard 1회차당 1개 session_id (funnel 조인 키). 최초 1회 생성 후 sessionStorage에 고정 —
 * 리렌더·StrictMode 더블마운트·스텝 이동에도 동일값을 반환한다.
 */
export function getOnboardingSessionId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return '';
  }
}

function buildBody(event: OnboardingEvent, payload?: EventPayload): string {
  return JSON.stringify({
    event,
    session_id: getOnboardingSessionId(),
    agent_id: payload?.agent_id ?? null,
    runtime: payload?.runtime ?? 'claude-code',
    failure_reason: payload?.failure_reason ?? null,
    client_ts: new Date().toISOString(),
  });
}

/** fire-and-forget emit. keepalive로 짧은 unload에도 best-effort 전송. 실패는 swallow. */
export function emitOnboardingEvent(event: OnboardingEvent, payload?: EventPayload): void {
  if (typeof window === 'undefined') return;
  try {
    void fetch('/api/onboarding/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildBody(event, payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // swallow — 측정은 절대 UX를 막지 않는다
  }
}

/** unload 경로(탭 닫기/라우트 이탈) best-effort. sendBeacon 우선, 미지원 시 keepalive fetch. */
export function beaconOnboardingEvent(event: OnboardingEvent, payload?: EventPayload): void {
  if (typeof window === 'undefined') return;
  try {
    const body = buildBody(event, payload);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon('/api/onboarding/events', new Blob([body], { type: 'application/json' }));
    } else {
      emitOnboardingEvent(event, payload);
    }
  } catch {
    // swallow
  }
}
