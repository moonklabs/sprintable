// story #2101 — event_id 기반 SSE dedup 유틸 회귀가드. 백엔드 백필 확대(최근 delivered
// 포함, 다중 탭 영구 유실 방지)가 만드는 중복 배달을 클라가 정확히 한 번으로 좁히는지.

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

describe('createSeenIdTracker', () => {
  it('reports unseen ids as not seen, then seen after markSeen', () => {
    const tracker = createSeenIdTracker();
    expect(tracker.hasSeen('a')).toBe(false);
    tracker.markSeen('a');
    expect(tracker.hasSeen('a')).toBe(true);
  });

  it('evicts oldest id once bound exceeded (bounded memory — no unbounded growth)', () => {
    const tracker = createSeenIdTracker();
    for (let i = 0; i < 501; i++) tracker.markSeen(`id-${i}`);
    // id-0이 501번째 추가로 밀려나야(FIFO 경계 500)
    expect(tracker.hasSeen('id-0')).toBe(false);
    expect(tracker.hasSeen('id-500')).toBe(true);
  });
});

describe('shouldSuppressDuplicateSseEvent', () => {
  it('suppresses the second delivery of a duplicate event_id, passes distinct ones', () => {
    const tracker = createSeenIdTracker();
    const calls: string[] = [];
    const handle = (raw: string) => {
      if (shouldSuppressDuplicateSseEvent(tracker, raw)) return;
      calls.push(raw);
    };

    const payload = '{"event_id":"dup-1","content":"hi"}';
    handle(payload);
    handle(payload); // 재배달(같은 event_id) — 두 번째는 억제돼야
    handle('{"event_id":"dup-2","content":"bye"}');

    expect(calls).toEqual([payload, '{"event_id":"dup-2","content":"bye"}']);
  });

  it('never suppresses when event_id is absent (no regression for legacy payloads)', () => {
    const tracker = createSeenIdTracker();
    const calls: string[] = [];
    const handle = (raw: string) => {
      if (shouldSuppressDuplicateSseEvent(tracker, raw)) return;
      calls.push(raw);
    };

    const payload = '{"no_id":"legacy"}';
    handle(payload);
    handle(payload);

    expect(calls).toEqual([payload, payload]);
  });
});
