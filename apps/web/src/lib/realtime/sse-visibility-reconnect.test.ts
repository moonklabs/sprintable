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
