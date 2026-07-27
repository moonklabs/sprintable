// story #2101 — event_id 기반 SSE dedup 유틸 회귀가드. 백엔드 백필 확대(최근 delivered
// 포함, 다중 탭 영구 유실 방지)가 만드는 중복 배달을 클라가 정확히 한 번으로 좁히는지.
//
// story #2163 — shouldSuppressDuplicateSseEvent는 더 이상 모듈 스코프 싱글턴을 쓰지 않는다.
// 호출부가 자기 tracker(createSeenIdTracker())를 만들어 넘긴다 — 전역이었을 때 "같은 탭 안의
// 서로 다른 useChatSse 컨슈머(ChatView·GNB 뱃지)가 같은 event_id를 두고 서로를 굶기던" 결함의
// 회귀가드가 아래 "두 컨슈머" 블록이다. #2101의 원 목적(같은 컨슈머가 재연결 백필로 같은
// 이벤트를 두 번 받는 것 억제)은 "같은 tracker" 블록이 그대로 지킨다 — 이 둘이 쌍으로 있어야
// "이번 결함을 고치다 #2101을 깼는지"를 가를 수 있다.

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

describe('shouldSuppressDuplicateSseEvent — 같은 tracker(story #2101 원 목적, 아직 지켜지는지)', () => {
  it('suppresses the second delivery of a duplicate event_id, passes distinct ones', () => {
    const tracker = createSeenIdTracker();
    const idA = 'sup-dup-1';
    const idB = 'sup-dup-2';
    expect(shouldSuppressDuplicateSseEvent(`{"event_id":"${idA}"}`, tracker)).toBe(false);
    expect(shouldSuppressDuplicateSseEvent(`{"event_id":"${idA}"}`, tracker)).toBe(true); // 재배달 억제
    expect(shouldSuppressDuplicateSseEvent(`{"event_id":"${idB}"}`, tracker)).toBe(false); // 별개 id는 통과
  });

  it('never suppresses when event_id is absent (no regression for legacy payloads)', () => {
    const tracker = createSeenIdTracker();
    const payload = '{"no_id":"legacy-sup"}';
    expect(shouldSuppressDuplicateSseEvent(payload, tracker)).toBe(false);
    expect(shouldSuppressDuplicateSseEvent(payload, tracker)).toBe(false);
  });

  it('simulates the handler-first-line convention used across use-chat-sse.ts/use-sse-notifications.ts', () => {
    const tracker = createSeenIdTracker();
    const calls: string[] = [];
    const handle = (raw: string) => {
      if (shouldSuppressDuplicateSseEvent(raw, tracker)) return;
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

// story #2163 — 이 블록이 이번 결함의 핵심 판별력이다. 전역 싱글턴이었을 때는 아래 첫 테스트가
// 실패했다(먼저 처리한 컨슈머가 마킹해 버려 두 번째 컨슈머가 자기 입장에서 "처음 보는" 이벤트를
// 못 받았다) — 뱃지는 +1 되는데 채팅창은 안 바뀌는 증상이 정확히 이것이었다.
describe('shouldSuppressDuplicateSseEvent — 서로 다른 tracker(컨슈머 간, 이번 결함)', () => {
  it('두 독립 컨슈머(ChatView·GNB 뱃지 흉내)가 같은 event_id를 각자 받는다 — 굶기지 않는다', () => {
    const chatViewTracker = createSeenIdTracker();
    const gnbBadgeTracker = createSeenIdTracker();
    const raw = '{"event_id":"cross-consumer-1","content":"hi"}';

    // GNB 뱃지가 먼저 처리한다고 가정(트리 상위라 먼저 구독되는 경향 — 실측된 순서).
    const gnbSuppressed = shouldSuppressDuplicateSseEvent(raw, gnbBadgeTracker);
    const chatViewSuppressed = shouldSuppressDuplicateSseEvent(raw, chatViewTracker);

    expect(gnbSuppressed).toBe(false); // 뱃지: +1
    expect(chatViewSuppressed).toBe(false); // 채팅창: 굶지 않고 자기 몫을 받는다(전역이면 여기서 true였다)
  });

  it('컨슈머가 3개여도 전부 각자 받는다(2개로 우연히 맞은 게 아님을 고정)', () => {
    const trackers = [createSeenIdTracker(), createSeenIdTracker(), createSeenIdTracker()];
    const raw = '{"event_id":"cross-consumer-triple","content":"hi"}';

    const results = trackers.map((t) => shouldSuppressDuplicateSseEvent(raw, t));

    expect(results).toEqual([false, false, false]);
  });
});
