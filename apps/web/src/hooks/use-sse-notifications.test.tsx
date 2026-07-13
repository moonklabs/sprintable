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
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: { data: string; lastEventId?: string }) => void>> = {};
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string, _opts?: unknown) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string; lastEventId?: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() { this.closed = true; }
  emit(type: string, data: string) {
    for (const cb of this.listeners[type] ?? []) cb({ data });
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
