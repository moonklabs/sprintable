// @vitest-environment jsdom
//
// 9ef0f914 — useSseNotifications의 extraEventNames/onExtraEvent additive 확장 회귀가드.
// 실 EventSource가 없는 jsdom이라 FakeEventSource로 addEventListener 배선만 검증(네트워크/BE
// 없음 — 계약 payload는 doc trust-pipeline-be-design §4 그대로, 라이브 E2E는 별건).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSseNotifications, type SseEventNotification } from './use-sse-notifications';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: { data: string; lastEventId?: string }) => void>> = {};
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  constructor(public url: string, _opts?: unknown) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string; lastEventId?: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() { this.closed = true; }
  emit(type: string, data: string, lastEventId?: string) {
    for (const cb of this.listeners[type] ?? []) cb({ data, lastEventId });
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Harness(props: Parameters<typeof useSseNotifications>[0]) {
  useSseNotifications(props);
  return null;
}

const TRUST_STAGE_PAYLOAD = {
  story_id: 'story-1', project_id: 'proj-1', org_id: 'org-1',
  old_stage: 'running', new_stage: 'needs_input',
  exception_signals: { blocked: false, verify_fail: false, needs_input: true, scope_violation: false, merge_ready: false },
  reason: null, actor_id: null, timestamp: '2026-07-13T00:00:00Z',
};

describe('useSseNotifications — extraEventNames/onExtraEvent (additive, 9ef0f914)', () => {
  it('existing onNotification behavior is unaffected when no extra options are passed (regression guard)', () => {
    const onNotification = vi.fn();
    act(() => { root.render(<Harness onNotification={onNotification} memberId="m1" />); });
    const es = FakeEventSource.instances[0]!;
    const notif: SseEventNotification = {
      event_type: 'story_status_changed', source_entity_type: 'story', source_entity_id: 's1',
      payload: { summary: 'x' }, read_at: null, created_at: '2026-07-13T00:00:00Z',
    };
    act(() => { es.emit('notification', JSON.stringify(notif)); });
    expect(onNotification).toHaveBeenCalledWith(notif);
  });

  it('does not register any extra listeners when extraEventNames is omitted', () => {
    act(() => { root.render(<Harness onNotification={vi.fn()} memberId="m1" />); });
    const es = FakeEventSource.instances[0]!;
    expect(es.listeners['story.trust_stage_changed']).toBeUndefined();
  });

  it('invokes onExtraEvent with the parsed contract payload when the named event fires', () => {
    const onExtraEvent = vi.fn();
    act(() => {
      root.render(
        <Harness memberId="m1" extraEventNames={['story.trust_stage_changed']} onExtraEvent={onExtraEvent} />,
      );
    });
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('story.trust_stage_changed', JSON.stringify(TRUST_STAGE_PAYLOAD)); });
    expect(onExtraEvent).toHaveBeenCalledWith('story.trust_stage_changed', TRUST_STAGE_PAYLOAD);
  });

  it('swallows malformed extra-event payloads without throwing (no-fiction: never crash on bad data)', () => {
    const onExtraEvent = vi.fn();
    act(() => {
      root.render(
        <Harness memberId="m1" extraEventNames={['story.trust_stage_changed']} onExtraEvent={onExtraEvent} />,
      );
    });
    const es = FakeEventSource.instances[0]!;
    expect(() => act(() => { es.emit('story.trust_stage_changed', 'not json'); })).not.toThrow();
    expect(onExtraEvent).not.toHaveBeenCalled();
  });

  it('onNotification is optional — a consumer using only extraEventNames does not need to supply it', () => {
    const onExtraEvent = vi.fn();
    expect(() => {
      act(() => {
        root.render(<Harness memberId="m1" extraEventNames={['story.trust_stage_changed']} onExtraEvent={onExtraEvent} />);
      });
    }).not.toThrow();
    const es = FakeEventSource.instances[0]!;
    // 기존 알림 채널도 여전히 안전하게(콜백 없어도 크래시 0).
    expect(() => act(() => { es.emit('notification', JSON.stringify({})); })).not.toThrow();
  });
});

// story #2162 — 재개 커서(last_event_id) B계열 오염 방지의 standalone-fallback 경로 회귀가드.
describe('useSseNotifications — 재개 커서 B계열 오염 방지(#2162)', () => {
  async function triggerTransientReconnect() {
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => {
      es.readyState = FakeEventSource.CONNECTING; // 정상 순단(#2160 세션 확認 경로 안 탐)
      es.onerror?.();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('extraEventNames로 받은 B계열(conversation.working) id는 커서로 승격되지 않는다', async () => {
    await act(async () => {
      root.render(
        <Harness memberId="m1" extraEventNames={['conversation.working']} onExtraEvent={vi.fn()} />,
      );
    });
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('conversation.working', JSON.stringify({}), 'transient-uuid-1'); });

    await triggerTransientReconnect();

    const reconnectUrl = new URL(FakeEventSource.instances[FakeEventSource.instances.length - 1]!.url);
    expect(reconnectUrl.searchParams.get('last_event_id')).toBeNull();
  });

  it('extraEventNames로 받은 A계열(story.trust_stage_changed) id는 커서로 승격된다', async () => {
    await act(async () => {
      root.render(
        <Harness memberId="m1" extraEventNames={['story.trust_stage_changed']} onExtraEvent={vi.fn()} />,
      );
    });
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('story.trust_stage_changed', JSON.stringify(TRUST_STAGE_PAYLOAD), 'db-event-id-1'); });

    await triggerTransientReconnect();

    const reconnectUrl = new URL(FakeEventSource.instances[FakeEventSource.instances.length - 1]!.url);
    expect(reconnectUrl.searchParams.get('last_event_id')).toBe('db-event-id-1');
  });
});

// story #2964(sse-multiplexer.ts #2940과 동일 클래스, 폴백 경로 전용) — 이 파일 전체가 mux
// OFF(Provider 밖) 조건이라 항상 폴백 분기를 탄다. mux ON이면 이 훅은 이 effect 자체를
// 안 타므로(위 mux 분기) 이 회귀가드는 구조적으로 "폴백 경로 전용" 검증 — dev는 지금 mux
// live라 급하진 않되(story 설명 그대로), 같은 클래스 결함을 사전에 닫는다.
describe('useSseNotifications — org 전환(memberId 변경) 재연결(story #2964, mux OFF 폴백 경로 전용)', () => {
  it('memberId가 바뀌면 옛 커넥션을 닫고 새 member_id로 재연결한다', async () => {
    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="member-org-a" />); });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toContain('member_id=member-org-a');
    expect(FakeEventSource.instances[0]!.closed).toBe(false);

    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="member-org-b" />); });

    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain('member_id=member-org-b');
  });

  it('memberId 전환 시 옛 org의 last_event_id를 새 커넥션 URL에 안 싣는다', async () => {
    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="member-org-a" />); });
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('notification', JSON.stringify({}), 'org-a-last-event-id'); });

    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="member-org-b" />); });

    const url = new URL(FakeEventSource.instances[FakeEventSource.instances.length - 1]!.url);
    expect(url.searchParams.get('member_id')).toBe('member-org-b');
    expect(url.searchParams.get('last_event_id')).toBeNull(); // ⭐핵심 — 옛 org 커서가 안 샌다.
  });

  it('memberId가 안 바뀌면(무관한 리렌더) 재연결하지 않는다 — 과잉 재연결 금지', async () => {
    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="member-org-a" />); });
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="member-org-a" />); });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
  });
});

// story #2987(PO beyond-diff 지적) — chat과 동일 좀비 커넥션 클래스가 알림 SSE의 mux OFF
// 폴백 경로에도 있었다(mux ON이면 sse-multiplexer.ts 처방이 이미 커버 — 이 회귀가드는
// fallback 전용). sse-multiplexer.test.tsx·use-chat-sse.test.tsx와 동형 시나리오.
describe('useSseNotifications — 가시성 복귀 강제 재연결(#2987, mux OFF 폴백 경로 전용)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('임계값(3s) 이상 숨겨졌다 돌아오면 기존 커넥션을 닫고 새로 연다', async () => {
    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="m1" />); });
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    act(() => { setVisibility('visible'); });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it('임계값(3s) 미만의 짧은 전환은 재연결하지 않는다 — 처칭 방지', async () => {
    await act(async () => { root.render(<Harness onNotification={vi.fn()} memberId="m1" />); });

    act(() => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    act(() => { setVisibility('visible'); });

    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
