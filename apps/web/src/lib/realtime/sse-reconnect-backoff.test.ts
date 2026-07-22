// story #2095 — 실측(30분·71회·60~68초 클러스터, dev-app 프론트 Cloud Run timeout=60초 원인,
// 의도된 트레이드오프라 유지) 기반 재연결 backoff 계약 고정.
//
// 핵심 계약:
// ① 연결이 HEALTHY_CONNECTION_MS(10초) 이상 붙어 있다가 끊기면 실패 카운트를 즉시 잊는다
//    (정상 60초 사이클에서 backoff가 절대 안 치솟는다).
// ② 10초 미만에 끊기면(핸드셰이크 직후 등) 실패 카운트가 유지·증가한다(서버가 진짜
//    죽었을 때만 벌어지는 시나리오 — 그 경우도 상한 20초로 재시도 폭풍을 막는다).
// ③ 상한은 300초→20초로 낮아졌다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReconnectBackoffState, RECONNECT_DELAYS_MS } from './sse-reconnect-backoff';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createReconnectBackoffState — story #2095', () => {
  it('최초 연결이 열리기도 전에 에러가 나면(핸드셰이크 실패) 1단계 지연(1s)을 반환한다', () => {
    const backoff = createReconnectBackoffState();
    expect(backoff.onError()).toBe(RECONNECT_DELAYS_MS[0]);
  });

  it('핸드셰이크가 반복 실패하면(open 없이 error만) 지연이 단계적으로 상승하고 상한(20s)에서 멈춘다', () => {
    const backoff = createReconnectBackoffState();
    const delays = [backoff.onError(), backoff.onError(), backoff.onError(), backoff.onError(), backoff.onError()];
    expect(delays).toEqual([1_000, 3_000, 8_000, 20_000, 20_000]);
  });

  it('연결이 10초 미만으로 붙어있다가 끊기면 — 진짜 불안정으로 보고 카운트가 계속 오른다', () => {
    const backoff = createReconnectBackoffState();
    expect(backoff.onError()).toBe(1_000); // 1회차: 핸드셰이크 실패
    backoff.onOpen();
    vi.advanceTimersByTime(5_000); // 5초만 붙어있다가 끊김(HEALTHY 10초 미만)
    expect(backoff.onError()).toBe(3_000); // 리셋 안 되고 2단계로 계속 상승
  });

  it('연결이 10초 이상 붙어있다가 끊기면 — 정상 사이클로 보고 카운트를 즉시 잊는다', () => {
    const backoff = createReconnectBackoffState();
    expect(backoff.onError()).toBe(1_000); // 1회차: 핸드셰이크 실패로 카운트 상승 시작
    expect(backoff.onError()).toBe(3_000); // 2회차
    backoff.onOpen();
    vi.advanceTimersByTime(10_000); // 정확히 경계값(10초) 이상 붙어있었음
    expect(backoff.onError()).toBe(1_000); // 리셋됨 — 다시 1단계
  });

  it('60~68초 정상 사이클을 여러 번 반복해도(실측 재현) 지연이 항상 1단계(1s)로 유지된다', () => {
    const backoff = createReconnectBackoffState();
    for (let cycle = 0; cycle < 5; cycle++) {
      backoff.onOpen();
      vi.advanceTimersByTime(64_000); // 실측 평균 근사(60~68초 클러스터 중앙값)
      expect(backoff.onError()).toBe(1_000);
    }
  });

  it('isReconnect()는 최초 연결(에러 이력 없음)에서는 false, 에러를 한 번이라도 겪은 뒤에는 true다', () => {
    const backoff = createReconnectBackoffState();
    expect(backoff.isReconnect()).toBe(false);
    backoff.onOpen(); // 최초 연결 성공 — 아직 에러 이력 없음
    expect(backoff.isReconnect()).toBe(false);
    backoff.onError();
    expect(backoff.isReconnect()).toBe(true);
    backoff.onOpen(); // 재연결 성공 — 에러 이력이 있었으므로 true 유지
    expect(backoff.isReconnect()).toBe(true);
  });

  it('연결이 정확히 경계값 미만(9.999초)이면 여전히 불안정으로 취급한다', () => {
    const backoff = createReconnectBackoffState();
    backoff.onError(); // 1단계로 진입
    backoff.onOpen();
    vi.advanceTimersByTime(9_999);
    expect(backoff.onError()).toBe(3_000); // 리셋 안 됨
  });
});
