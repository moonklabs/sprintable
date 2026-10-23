// @vitest-environment jsdom
//
// useChatSse — 정규화 · 구독 · 폴링 fallback 시험. story #4698 — 이 훅은 스트림을 열지 않는다(독립 EventSource 폴백 삭제): 스트림은 RealtimeProvider
// (sse-multiplexer.ts)의 것이라 아래 시험은 Provider 안에서 돈다. 재개 커서 · 가시성/포커스 재연결 · org 전환 시험은 멀티플렉서 시험(sse-multiplexer.test.tsx)이
// 같은 동작을 이미 고정하고 있어 이 파일에서는 지웠다(폴백 경로 전용이던 중복 시험).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RealtimeProvider } from '@/components/realtime-provider';
import { useChatSse, normalizeToMessage, parseDeliveryWithheld, sentMessageFromAnswer } from './use-chat-sse';

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

describe('normalizeToMessage — story #3106(#3092 후속) sender.runtime_type 노출', () => {
  it('sender.runtime_type이 있으면 sender_runtime_type으로 실린다', () => {
    const raw = { id: 'm1', content: 'hi', sender: { id: 'u1', name: '오르테가', type: 'agent', runtime_type: 'claude-code' } };
    expect(normalizeToMessage(raw).sender_runtime_type).toBe('claude-code');
  });

  it('human sender는 runtime_type이 없어 null로 통일된다', () => {
    const raw = { id: 'm2', content: 'hi', sender: { id: 'u2', name: '송윤재', type: 'human' } };
    expect(normalizeToMessage(raw).sender_runtime_type).toBeNull();
  });

  it('sender 자체가 없으면 null로 통일된다', () => {
    expect(normalizeToMessage({ id: 'm3', content: 'hi' }).sender_runtime_type).toBeNull();
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

// story #4698 — 훅은 스트림을 열지 않는다(독립 EventSource 폴백 삭제). 스트림은 RealtimeProvider(멀티플렉서)의 것이라 시험도 Provider 안에서 돌린다.
function Inner(props: Parameters<typeof useChatSse>[0]) {
  useChatSse(props);
  return null;
}
function Harness(props: Parameters<typeof useChatSse>[0]) {
  return <RealtimeProvider currentTeamMemberId="m1"><Inner {...props} /></RealtimeProvider>;
}

describe('useChatSse — 동시 마운트된 두 인스턴스가 같은 이벤트를 각자 받는다(story #2163 · #4698 한 스트림)', () => {
  it('ChatView·GNB 뱃지 흉내 — 한 스트림의 같은 event_id conversation.message_created를 둘 다 받는다(스트림은 1개)', async () => {
    const onMessageA = vi.fn(); // ChatView 흉내
    const onMessageB = vi.fn(); // useChatUnreadTotal(GNB 뱃지) 흉내
    await act(async () => {
      root.render(
        <RealtimeProvider currentTeamMemberId="m1">
          <Inner onConversationMessage={onMessageA} />
          <Inner onConversationMessage={onMessageB} />
        </RealtimeProvider>,
      );
    });
    // 같은 Provider 아래면 인스턴스가 몇이든 스트림은 1개 — 한 프레임이 두 훅의 구독자에게 모두 간다(훅마다 자기 dedup tracker).
    expect(FakeEventSource.instances).toHaveLength(1);
    const payload = { id: 'msg-1', event_id: 'shared-event-1' };
    act(() => { FakeEventSource.instances[0]!.emit('conversation.message_created', payload); });

    expect(onMessageA).toHaveBeenCalledTimes(1); // 전역 싱글턴이면 여기가 0이었다(둘 중 하나가 굶음)
    expect(onMessageB).toHaveBeenCalledTimes(1);
  });
});

describe('useChatSse — mux 공유 커넥션 경로에서 connected 리렌더 반응성(story 6ddaa086)', () => {
  it('mux 최초 open(false→true)이 이 훅을 리렌더시켜 connected=true를 즉시 반영한다', async () => {
    const useChatSseFresh = useChatSse;

    const connectedCapture = { current: false };
    function Consumer() {
      const { connected } = useChatSseFresh({});
      useEffect(() => { connectedCapture.current = connected; }, [connected]);
      return null;
    }

    await act(async () => {
      root.render(
        <RealtimeProvider currentTeamMemberId="m1">
          <Consumer />
        </RealtimeProvider>,
      );
      await Promise.resolve();
    });
    expect(connectedCapture.current).toBe(false);

    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); });

    // 옛 버그: mux 핸들 참조가 안 바뀌어 Consumer가 리렌더 안 되고 connectedCapture가 false에
    // 고착됐다(PO 실측 — readyState=1인데 배너만 남는 그 증상). 고친 뒤엔 이 open 자체가
    // 곧바로 리렌더를 유발해 true로 반영된다 — 다른 무관한 트리거(새 메시지 등) 불필요.
    expect(connectedCapture.current).toBe(true);
  });

  it('재연결(error→새 인스턴스 open)에서도 다른 무관한 리렌더 없이 connected가 다시 true로 풀린다(PO 재현 시나리오)', async () => {
    const useChatSseFresh = useChatSse;

    const connectedCapture = { current: false };
    function Consumer() {
      const { connected } = useChatSseFresh({});
      useEffect(() => { connectedCapture.current = connected; }, [connected]);
      return null;
    }

    await act(async () => {
      root.render(
        <RealtimeProvider currentTeamMemberId="m1">
          <Consumer />
        </RealtimeProvider>,
      );
      await Promise.resolve();
    });
    const first = FakeEventSource.instances[0]!;
    await act(async () => { first.onopen?.(); await Promise.resolve(); });
    expect(connectedCapture.current).toBe(true);

    // 끊김 — PO 실측대로 배너가 뜨는 쪽(정상 동작).
    await act(async () => { first.readyState = FakeEventSource.CONNECTING; first.onerror?.(); await Promise.resolve(); });
    expect(connectedCapture.current).toBe(false);

    // 재연결 — 새 EventSource 인스턴스가 open(신규 인스턴스라는 게 PO 가설①의 핵심 축).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000); // backoff 재시도 대기
      const second = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
      second.onopen?.();
      await Promise.resolve();
    });
    expect(connectedCapture.current).toBe(true);
  });
});

// story #3621(FE·결함·high, 선생님 2026-09-07 05:45Z 실물) — 실시간이 죽어 있는 동안
// 화면이 "스스로" 낡음을 벗어나는 경로가 없던 것을 폴링 fallback으로 닫는다.
describe('useChatSse — 폴링 fallback(story #3621)', () => {
  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('connected가 threshold(10s) 미만으로 끊기면 onPoll을 부르지 않는다', async () => {
    const onPoll = vi.fn().mockResolvedValue(true);
    await act(async () => { root.render(<Harness onPoll={onPoll} />); });
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); });
    await act(async () => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); await Promise.resolve(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(onPoll).not.toHaveBeenCalled();
  });

  it('connected가 threshold(10s) 이상 머물면 onPoll이 불리기 시작한다(AC1)', async () => {
    const onPoll = vi.fn().mockResolvedValue(true);
    await act(async () => { root.render(<Harness onPoll={onPoll} />); });
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); });
    await act(async () => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); await Promise.resolve(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it('폴링 중엔 간격(15s)마다 반복 호출된다', async () => {
    const onPoll = vi.fn().mockResolvedValue(true);
    await act(async () => { root.render(<Harness onPoll={onPoll} />); });
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); });
    await act(async () => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); await Promise.resolve(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onPoll).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('재연결 성공(connected=true)이 되면 폴링을 즉시 멈춘다(AC2, backfill과 중복 0)', async () => {
    const onPoll = vi.fn().mockResolvedValue(true);
    const onReconnect = vi.fn();
    await act(async () => { root.render(<Harness onPoll={onPoll} onReconnect={onReconnect} />); });
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); });
    await act(async () => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onPoll).toHaveBeenCalledTimes(1);

    // 재연결 backoff 재시도가 새 EventSource 인스턴스를 만들 시간을 준 뒤 그걸 연다.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    const latest = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    await act(async () => { latest.onopen?.(); await Promise.resolve(); });
    expect(onReconnect).toHaveBeenCalledTimes(1);

    onPoll.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(onPoll).not.toHaveBeenCalled(); // 폴링이 멈췄다 — backfill(onReconnect)이 이어받았다.
  });

  it('탭이 백그라운드(hidden)면 폴링 호출을 쉬고, 복귀하면 재개한다(AC5)', async () => {
    const onPoll = vi.fn().mockResolvedValue(true);
    await act(async () => { root.render(<Harness onPoll={onPoll} />); });
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); });
    await act(async () => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onPoll).toHaveBeenCalledTimes(1);

    onPoll.mockClear();
    act(() => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); // 폴 간격(15s) 두 배를 넘겨도
    expect(onPoll).not.toHaveBeenCalled(); // 백그라운드에선 안 부른다.

    act(() => { setVisibility('visible'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); // 가시성 재확인 poke 간격
    expect(onPoll).toHaveBeenCalledTimes(1); // 복귀 즉시 재개.
  });

  // ⭐뮤테이션 표적 — threshold 가드(POLL_THRESHOLD_MS)를 지우면 위 "10s 미만" 테스트가
  // RED여야 한다(연결 순단마다 폴링이 켜지는 소음 회귀).
  it('⭐뮤테이션 대조 — onPoll 자체가 없으면(옵션 생략) 아무 타이머도 안 돈다', async () => {
    await act(async () => { root.render(<Harness />); });
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); await Promise.resolve(); });
    await act(async () => { es.readyState = FakeEventSource.CONNECTING; es.onerror?.(); await Promise.resolve(); });
    // onPoll이 없으니 폴링 effect 자체가 조기 return — 타이머 advance가 아무 것도 못 건드려도
    // (에러 없이) 통과해야 한다. 이 테스트의 존재 의의는 "onPoll 없을 때도 회귀 없음" 확인.
    await expect(act(async () => { await vi.advanceTimersByTimeAsync(60_000); })).resolves.not.toThrow();
  });
});


describe('useChatSse — 세 이벤트 채널이 공유 스트림으로 각자의 콜백에 닿는다(story #4698)', () => {
  it('conversation.message_created · conversation.working · conversation.read가 각각 onConversationMessage · onWorking · onConversationRead로 간다', async () => {
    const onMessage = vi.fn(); const onWorking = vi.fn(); const onRead = vi.fn();
    await act(async () => { root.render(<Harness onConversationMessage={onMessage} onWorking={onWorking} onConversationRead={onRead} />); });
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('conversation.message_created', { id: 'm1', event_id: 'e-msg' }); });
    act(() => { es.emit('conversation.working', { conversation_id: 'c1', working: [] }); });
    act(() => { es.emit('conversation.read', { conversation_id: 'c1', member_id: 'm1' }); });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onWorking).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledTimes(1);
  });
});


describe('story #4430 — delivery_withheld is kept on the way in (a dropped field would be a quiet success again)', () => {
  it('normalizeToMessage keeps a read\'s delivery_withheld; absent stays absent', () => {
    const m = normalizeToMessage({ id: 'm1', content: 'x', delivery_withheld: { withheld_count: 2, reason: 'recipient_blocked_sender', conversation_type: 'group' } });
    expect(m.delivery_withheld).toEqual({ withheld_count: 2, conversation_type: 'group' });
    expect(normalizeToMessage({ id: 'm2', content: 'y' }).delivery_withheld).toBeUndefined();
  });

  it('the send answer\'s sibling `delivery` lands on the sender\'s own line', () => {
    const m = sentMessageFromAnswer({
      data: { id: 'm3', content: 'z', sender: { id: 'me' } },
      delivery: { withheld_count: 1, reason: 'recipient_blocked_sender', conversation_type: 'dm' },
    });
    expect(m.id).toBe('m3');
    expect(m.delivery_withheld).toEqual({ withheld_count: 1, conversation_type: 'dm' });
    expect(sentMessageFromAnswer({ data: { id: 'm4', content: 'w' } }).delivery_withheld).toBeUndefined();
  });

  it('only a positive integer count counts; an unknown kind is dropped (the line then uses the count wording)', () => {
    for (const bad of [null, undefined, 'x', {}, { withheld_count: 0 }, { withheld_count: -1 }, { withheld_count: 1.5 }, { withheld_count: '2' }]) {
      expect(parseDeliveryWithheld(bad)).toBeUndefined();
    }
    expect(parseDeliveryWithheld({ withheld_count: 1, conversation_type: 'channel' })).toEqual({ withheld_count: 1 });
  });
});
