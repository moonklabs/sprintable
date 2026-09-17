// OB-4 온보딩 funnel 측정 emit (계약 `ob-4-onboarding-funnel-measurement-contract` v1.2).
// FE 분담 4종만 emit. 레일 표시(OB-2)와는 분리된 vocab. emit은 non-blocking·fail-silent —
// 측정 실패가 wizard UX를 절대 막지 않는다.

const SESSION_KEY = 'sprintable_onboarding_session_id';

export type OnboardingEvent =
  | 'onboarding_started'
  | 'config_copied'
  | 'verify_started'
  | 'abandoned_explicit'
  // story #3983(페드루 PO CHANGES 2026-09-17 02:11Z) — 웹 connect는 config_copied·
  // verify_started로 활성화 진행을 재지만, 데스크톱 경로는 신호가 0이라 둘을
  // 못 갈랐다 — 데스크톱 절 완료 버튼 클릭 시 emit.
  | 'desktop_handoff_selected'
  // story #3983 CHANGES r2(페드루 PO 2026-09-17 02:23Z) — 데스크톱 키 복사가
  // config_copied(웹 경로 이벤트·verify rail 첫 상태)를 재사용하면 데스크톱
  // 복사가 웹 설정 복사로 섞여 들어가 ④가 가르려던 퍼널이 다시 흐려진다 —
  // 별도 이름.
  | 'desktop_key_copied';

// story(2026-08-02, 채용 흐름 텔레메트리 부재) — 두 흐름(onboarding/connect-step.tsx ·
// recruiter STEP5)이 같은 이벤트 이름을 쏘게 되면서, 합계만 보고는 어느 흐름에서 온
// 이벤트인지 구분이 안 된다. 확認: 백엔드 OnboardingEventBody(pydantic)에 이미
// `meta: dict` 필드가 있고 OnboardingEvent 모델까지 JSONB로 실제 저장되는 것까지 이어진다
// — 새 top-level 필드를 추가하는 것보다 안전한 확장 지점이라 flow는 meta 안에 담는다.
export type OnboardingFlow = 'onboarding' | 'recruit';

interface EventPayload {
  agent_id?: string | null;
  runtime?: string;
  failure_reason?: string;
  flow?: OnboardingFlow;
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
    meta: payload?.flow ? { flow: payload.flow } : {},
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
