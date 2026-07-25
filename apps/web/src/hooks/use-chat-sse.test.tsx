// @vitest-environment jsdom
//
// story #2162 — useChatSse의 standalone-fallback(mux OFF/Provider 밖) 경로 재개 커서
// 오염 방지 회귀가드. Provider 없이 렌더하면 useSseMultiplexerContext()가 null을 반환해
// 독립 EventSource 폴백 분기를 타는 것을 이용한다(SseMultiplexerContext 기본값 null).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatSse } from './use-chat-sse';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: { data: string; lastEventId?: string }) => void>> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string; lastEventId?: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown, lastEventId?: string) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data), lastEventId });
  }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Harness(props: Parameters<typeof useChatSse>[0]) {
  useChatSse(props);
  return null;
}

async function triggerTransientReconnect() {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  await act(async () => {
    es.readyState = FakeEventSource.CONNECTING; // 정상 순단(#2160 세션 확認 경로 안 탐)
    es.onerror?.();
    await Promise.resolve();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
}

function lastReconnectUrl() {
  return new URL(FakeEventSource.instances[FakeEventSource.instances.length - 1]!.url);
}

describe('useChatSse — 재개 커서 B계열 오염 방지(#2162, standalone-fallback)', () => {
  it('conversation.working(B계열) id는 커서로 승격되지 않는다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('conversation.working', { conversation_id: 'c1', working: [] }, 'transient-uuid-1'); });

    await triggerTransientReconnect();

    expect(lastReconnectUrl().searchParams.get('last_event_id')).toBeNull();
  });

  it('conversation.message_created(A계열) id는 커서로 승격된다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('conversation.message_created', { id: 'msg-1' }, 'db-event-id-1'); });

    await triggerTransientReconnect();

    expect(lastReconnectUrl().searchParams.get('last_event_id')).toBe('db-event-id-1');
  });

  it('conversation.read(A계열) id는 커서로 승격된다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.emit('conversation.read', { conversation_id: 'c1', member_id: 'm2', last_read_at: '2026-07-25T00:00:00Z', unread_count: 0 }, 'db-event-id-2');
    });

    await triggerTransientReconnect();

    expect(lastReconnectUrl().searchParams.get('last_event_id')).toBe('db-event-id-2');
  });

  it('핵심 시나리오 — A계열 수신 뒤 B계열이 마지막으로 와도 커서는 A계열 id를 유지한다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('conversation.message_created', { id: 'msg-1' }, 'a-series-id'); });
    act(() => { es.emit('conversation.working', { conversation_id: 'c1', working: [] }, 'b-series-id'); });

    await triggerTransientReconnect();

    expect(lastReconnectUrl().searchParams.get('last_event_id')).toBe('a-series-id');
  });
});
