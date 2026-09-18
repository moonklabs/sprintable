// story #3621 — createPollBackoffState 순수 산술 회귀가드(스케줄링·threshold·visibility
// 게이팅은 use-chat-sse.test.tsx 몫, 여긴 "다음 간격이 얼마여야 하는지"만).
import { describe, expect, it } from 'vitest';
import { createPollBackoffState, POLL_INTERVAL_MS, POLL_MAX_INTERVAL_MS } from './sse-polling-fallback';

describe('createPollBackoffState — story #3621', () => {
  it('초기 간격은 기본값(15s)이다', () => {
    const state = createPollBackoffState();
    expect(state.currentIntervalMs()).toBe(POLL_INTERVAL_MS);
  });

  it('성공(true)마다 기본 간격으로 유지된다', () => {
    const state = createPollBackoffState();
    state.onPollResult(true);
    expect(state.currentIntervalMs()).toBe(POLL_INTERVAL_MS);
    state.onPollResult(true);
    expect(state.currentIntervalMs()).toBe(POLL_INTERVAL_MS);
  });

  it('연속 실패(false)마다 간격이 배로 늘어 상한(30s)에서 멈춘다', () => {
    const state = createPollBackoffState();
    state.onPollResult(false);
    expect(state.currentIntervalMs()).toBe(POLL_MAX_INTERVAL_MS); // 15s*2=30s=상한 그대로
    state.onPollResult(false);
    expect(state.currentIntervalMs()).toBe(POLL_MAX_INTERVAL_MS); // 더 안 늘어난다
  });

  it('실패 뒤 성공하면 즉시 기본 간격으로 복귀한다', () => {
    const state = createPollBackoffState();
    state.onPollResult(false);
    expect(state.currentIntervalMs()).toBe(POLL_MAX_INTERVAL_MS);
    state.onPollResult(true);
    expect(state.currentIntervalMs()).toBe(POLL_INTERVAL_MS);
  });

  it('옵션으로 기본/상한 간격을 바꿀 수 있다', () => {
    const state = createPollBackoffState({ intervalMs: 5_000, maxIntervalMs: 12_000 });
    expect(state.currentIntervalMs()).toBe(5_000);
    state.onPollResult(false);
    expect(state.currentIntervalMs()).toBe(10_000);
    state.onPollResult(false);
    expect(state.currentIntervalMs()).toBe(12_000); // 상한(2배=20000)을 넘지 않고 클램프
  });

  // ⭐뮤테이션 표적 — onPollResult(false)에서 Math.min(...maxIntervalMs) 클램프를 지우면
  // 위 마지막 두 테스트가 RED여야 한다(간격이 무한정 커진다).
});
