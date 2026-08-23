// @vitest-environment jsdom
//
// story #2162 — useChatSse의 standalone-fallback(mux OFF/Provider 밖) 경로 재개 커서
// 오염 방지 회귀가드. Provider 없이 렌더하면 useSseMultiplexerContext()가 null을 반환해
// 독립 EventSource 폴백 분기를 타는 것을 이용한다(SseMultiplexerContext 기본값 null).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatSse, normalizeToMessage } from './use-chat-sse';

describe('normalizeToMessage — story #2604 P2 approval_target 노출', () => {
  it('raw payload에 approval_target이 있으면 그대로 실린다', () => {
    const raw = {
      id: 'm1', content: "'x' 문서 결재 요청",
      approval_target: { work_item_type: 'doc', work_item_id: 'd1', gate_id: 'g1', actions: ['approve', 'reject'] },
    };
    expect(normalizeToMessage(raw).approval_target).toEqual({
      work_item_type: 'doc', work_item_id: 'd1', gate_id: 'g1', actions: ['approve', 'reject'],
    });
  });

  it('키 자체가 없는(구 서버) payload는 null로 통일된다', () => {
    expect(normalizeToMessage({ id: 'm2', content: 'hi' }).approval_target).toBeNull();
  });

  it('BE가 additive로 null을 명시해 보내도 null 그대로다', () => {
    expect(normalizeToMessage({ id: 'm3', content: 'hi', approval_target: null }).approval_target).toBeNull();
  });
});

describe('normalizeToMessage — story #2901 sender.avatar_url 노출', () => {
  it('sender.avatar_url이 있으면 sender_avatar_url로 실린다', () => {
    const raw = { id: 'm1', content: 'hi', sender: { id: 'u1', name: '오르테가', type: 'agent', avatar_url: 'https://cdn.test/a.png' } };
    expect(normalizeToMessage(raw).sender_avatar_url).toBe('https://cdn.test/a.png');
  });

  it('sender.avatar_url이 없으면(레거시 OrgMember 소싱 등) null로 통일된다', () => {
    const raw = { id: 'm2', content: 'hi', sender: { id: 'u2', name: '송윤재', type: 'human' } };
    expect(normalizeToMessage(raw).sender_avatar_url).toBeNull();
  });

  it('sender 자체가 없으면 null로 통일된다', () => {
    expect(normalizeToMessage({ id: 'm3', content: 'hi' }).sender_avatar_url).toBeNull();
  });
});

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

// story #2163 — 「알림은 오는데 화면은 안 바뀐다」 정신병의 근본이었던 그 시나리오를 실 훅
// 두 인스턴스로 직접 재현한다. dedup tracker가 모듈 전역 싱글턴이던 시절엔 두 번째 인스턴스가
// 굶었다(먼저 처리한 쪽이 event_id를 "이미 봤다"로 마킹) — ChatView와 GNB 뱃지(useChatUnreadTotal)
// 가 같은 탭에서 동시에 useChatSse를 부르는 실제 배치와 동형이다.
describe('useChatSse — 동시 마운트된 두 인스턴스가 같은 이벤트를 각자 받는다(story #2163)', () => {
  it('ChatView·GNB 뱃지 흉내 — 같은 event_id의 conversation.message_created를 둘 다 받는다', async () => {
    const onMessageA = vi.fn(); // ChatView 흉내
    const onMessageB = vi.fn(); // useChatUnreadTotal(GNB 뱃지) 흉내
    await act(async () => {
      root.render(
        <>
          <Harness currentTeamMemberId="m1" onConversationMessage={onMessageA} />
          <Harness currentTeamMemberId="m1" onConversationMessage={onMessageB} />
        </>,
      );
    });
    // mux OFF(Provider 밖)라 인스턴스마다 독립 EventSource — 서버가 둘 다에 같은 프레임을 민다.
    expect(FakeEventSource.instances).toHaveLength(2);
    const payload = { id: 'msg-1', event_id: 'shared-event-1' };
    act(() => { FakeEventSource.instances[0]!.emit('conversation.message_created', payload); });
    act(() => { FakeEventSource.instances[1]!.emit('conversation.message_created', payload); });

    expect(onMessageA).toHaveBeenCalledTimes(1); // 전역 싱글턴이면 여기가 0이었다(둘 중 하나가 굶음)
    expect(onMessageB).toHaveBeenCalledTimes(1);
  });
});

// story #2964(sse-multiplexer.ts #2940과 동일 클래스, 폴백 경로 전용) — mux OFF(Provider 밖,
// 이 파일 전체가 이미 그 조건)일 때만 실제로 발현하던 결함. mux ON(RealtimeProvider 안)이면
// 이 훅은 애초에 이 effect 자체를 안 타므로(위 mux 분기), 이 회귀가드는 구조적으로 "폴백
// 경로 전용" 검증이다 — dev가 지금 mux live라 급하진 않되(story 설명 그대로), 같은 클래스
// 결함을 사전에 닫는다.
describe('useChatSse — org 전환(memberId 변경) 재연결(story #2964, mux OFF 폴백 경로 전용)', () => {
  it('currentTeamMemberId가 바뀌면 옛 커넥션을 닫고 새 member_id로 재연결한다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="member-org-a" />); });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toContain('member_id=member-org-a');
    expect(FakeEventSource.instances[0]!.closed).toBe(false);

    await act(async () => { root.render(<Harness currentTeamMemberId="member-org-b" />); });

    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain('member_id=member-org-b');
  });

  it('memberId 전환 시 옛 org의 last_event_id를 새 커넥션 URL에 안 싣는다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="member-org-a" />); });
    act(() => {
      FakeEventSource.instances[0]!.emit(
        'conversation.message_created', { id: 'm1' }, 'org-a-last-event-id',
      );
    });

    await act(async () => { root.render(<Harness currentTeamMemberId="member-org-b" />); });

    const url = lastReconnectUrl();
    expect(url.searchParams.get('member_id')).toBe('member-org-b');
    expect(url.searchParams.get('last_event_id')).toBeNull(); // ⭐핵심 — 옛 org 커서가 안 샌다.
  });

  it('memberId가 안 바뀌면(무관한 리렌더) 재연결하지 않는다 — 과잉 재연결 금지', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="member-org-a" />); });
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => { root.render(<Harness currentTeamMemberId="member-org-a" />); });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
  });
});
