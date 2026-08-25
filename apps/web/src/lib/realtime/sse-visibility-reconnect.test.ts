// story #2987(선생님 실사용 지적) — "앱을 나갔다 들어와야 채팅이 갱신된다"의 근본원인은
// visibilitychange 복귀 시 SSE 커넥션 건강을 아무도 확認 안 하던 것. 이 모듈의 계약:
// ① 숨겨진 시간이 임계값(3s) 미만이면 재연결 불필요(false) — 데스크톱 짧은 탭 전환에서
//    매번 재연결하는 처칭 방지.
// ② 임계값 이상 숨겨졌다 돌아오면 강제 재연결 필요(true) — readyState를 안 믿는다(좀비
//    커넥션은 OPEN을 self-report할 수 있어 그 체크로는 못 잡는다는 게 이 fix의 핵심 근거).
// ③ hidden 없이(mount 직후 등) onVisible이 불려도 안전하게 false.
import { describe, expect, it } from 'vitest';
import { createVisibilityReconnectState } from './sse-visibility-reconnect';

describe('createVisibilityReconnectState — story #2987', () => {
  it('숨겨진 시간이 임계값(3s) 미만이면 재연결이 필요 없다(false) — 짧은 탭 전환', () => {
    let t = 0;
    const state = createVisibilityReconnectState(() => t);
    state.onHidden();
    t += 2_999;
    expect(state.onVisible()).toBe(false);
  });

  it('숨겨진 시간이 임계값(3s) 이상이면 강제 재연결이 필요하다(true) — 백그라운드 복귀', () => {
    let t = 0;
    const state = createVisibilityReconnectState(() => t);
    state.onHidden();
    t += 3_000;
    expect(state.onVisible()).toBe(true);
  });

  it('오래(수 분) 백그라운드에 있었어도 true(좀비 커넥션 의심 — readyState를 안 믿고 무조건 재연결)', () => {
    let t = 0;
    const state = createVisibilityReconnectState(() => t);
    state.onHidden();
    t += 5 * 60_000;
    expect(state.onVisible()).toBe(true);
  });

  it('onHidden 없이 onVisible이 불려도(마운트 직후 등) 안전하게 false를 반환한다', () => {
    const state = createVisibilityReconnectState(() => 0);
    expect(state.onVisible()).toBe(false);
  });

  it('한 번 판정 후 hiddenAt이 리셋돼 연속 onVisible 호출은 항상 false다(재진입 안전)', () => {
    let t = 0;
    const state = createVisibilityReconnectState(() => t);
    state.onHidden();
    t += 5_000;
    expect(state.onVisible()).toBe(true);
    expect(state.onVisible()).toBe(false);
  });
});

describe('createVisibilityReconnectState.onFocusRegained — story #3081', () => {
  it('onHidden이 한 번도 안 불려도(창이 계속 visible이었던 채 포커스만 복귀) true를 반환한다', () => {
    // 이게 이 fix의 핵심 계약 — onVisible()은 hidden 이력이 없으면 구조적으로 항상 false라
    // (위 "onHidden 없이 onVisible" 테스트 참고) focus만으로는 재연결이 안 걸렸었다.
    const state = createVisibilityReconnectState(() => 0);
    expect(state.onFocusRegained()).toBe(true);
  });

  it('짧은 시간 내 중복 focus는 두 번째부터 throttle되어 false다', () => {
    let t = 0;
    const state = createVisibilityReconnectState(() => t);
    expect(state.onFocusRegained()).toBe(true);
    t += 1_000; // throttle 창(3s) 안
    expect(state.onFocusRegained()).toBe(false);
  });

  it('throttle 창을 넘겨 다시 focus되면 다시 true다', () => {
    let t = 0;
    const state = createVisibilityReconnectState(() => t);
    expect(state.onFocusRegained()).toBe(true);
    t += 3_000;
    expect(state.onFocusRegained()).toBe(true);
  });

  it('onHidden/onVisible(가시성 축)과 완전히 독립적이다 — 서로 상태를 공유하지 않는다', () => {
    let t = 0;
    const state = createVisibilityReconnectState(() => t);
    // 가시성 축을 "숨겨진 적 없음"으로 소진시켜도 focus 축엔 영향 없음.
    expect(state.onVisible()).toBe(false);
    expect(state.onFocusRegained()).toBe(true);
    // 반대로 focus 축을 소진시켜도 가시성 축 판정(hidden 이력 기반)은 그대로 동작.
    state.onHidden();
    t += 3_000;
    expect(state.onVisible()).toBe(true);
  });
});
