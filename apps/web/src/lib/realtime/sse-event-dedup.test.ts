// story #2101 — event_id 기반 SSE dedup 유틸 회귀가드. 백엔드 백필 확대(최근 delivered
// 포함, 다중 탭 영구 유실 방지)가 만드는 중복 배달을 클라가 정확히 한 번으로 좁히는지.
//
// shouldSuppressDuplicateSseEvent는 모듈 스코프 싱글턴 tracker를 공유한다(react-hooks/refs
// lint가 handler를 HOC로 감싸는 패턴 자체를 막아, 각 handler 본문 첫 줄에서 직접 호출하는
// 관례로 감 — 설계 이력은 sse-event-dedup.ts 상단 주석 참고) — 이 파일의 테스트 케이스들은
// 서로 다른 event_id를 써서 싱글턴 상태 간섭을 피한다.

import { describe, expect, it } from 'vitest';
import { createSeenIdTracker, extractSseEventId, shouldSuppressDuplicateSseEvent } from './sse-event-dedup';

describe('extractSseEventId', () => {
  it('extracts event_id from valid JSON payload', () => {
    expect(extractSseEventId('{"event_id":"abc-123","other":1}')).toBe('abc-123');
  });

  it('returns null when event_id is absent', () => {
    expect(extractSseEventId('{"other":1}')).toBeNull();
  });

  it('returns null when event_id is not a string', () => {
    expect(extractSseEventId('{"event_id":123}')).toBeNull();
  });

  it('returns null on invalid JSON (does not throw)', () => {
    expect(extractSseEventId('not json')).toBeNull();
  });
});

describe('createSeenIdTracker (isolated instances — testability primitive)', () => {
  it('reports unseen ids as not seen, then seen after markSeen', () => {
    const tracker = createSeenIdTracker();
    expect(tracker.hasSeen('a')).toBe(false);
    tracker.markSeen('a');
    expect(tracker.hasSeen('a')).toBe(true);
  });

  it('evicts oldest id once bound exceeded (bounded memory — no unbounded growth)', () => {
    const tracker = createSeenIdTracker();
    for (let i = 0; i < 501; i++) tracker.markSeen(`iso-id-${i}`);
    // iso-id-0이 501번째 추가로 밀려나야(FIFO 경계 500)
    expect(tracker.hasSeen('iso-id-0')).toBe(false);
    expect(tracker.hasSeen('iso-id-500')).toBe(true);
  });
});

describe('shouldSuppressDuplicateSseEvent (module-scope singleton — production API)', () => {
  it('suppresses the second delivery of a duplicate event_id, passes distinct ones', () => {
    const idA = 'sup-dup-1';
    const idB = 'sup-dup-2';
    expect(shouldSuppressDuplicateSseEvent(`{"event_id":"${idA}"}`)).toBe(false);
    expect(shouldSuppressDuplicateSseEvent(`{"event_id":"${idA}"}`)).toBe(true); // 재배달 억제
    expect(shouldSuppressDuplicateSseEvent(`{"event_id":"${idB}"}`)).toBe(false); // 별개 id는 통과
  });

  it('never suppresses when event_id is absent (no regression for legacy payloads)', () => {
    const payload = '{"no_id":"legacy-sup"}';
    expect(shouldSuppressDuplicateSseEvent(payload)).toBe(false);
    expect(shouldSuppressDuplicateSseEvent(payload)).toBe(false);
  });

  it('simulates the handler-first-line convention used across use-chat-sse.ts/use-sse-notifications.ts', () => {
    const calls: string[] = [];
    const handle = (raw: string) => {
      if (shouldSuppressDuplicateSseEvent(raw)) return;
      calls.push(raw);
    };

    const idA = 'convention-dup-1';
    const idB = 'convention-dup-2';
    const payloadA = `{"event_id":"${idA}","content":"hi"}`;
    const payloadB = `{"event_id":"${idB}","content":"bye"}`;
    handle(payloadA);
    handle(payloadA); // 재배달(같은 event_id) — 두 번째는 억제돼야
    handle(payloadB);

    expect(calls).toEqual([payloadA, payloadB]);
  });
});
