// @vitest-environment jsdom
//
// story #2162 — useChatSse의 standalone-fallback(mux OFF/Provider 밖) 경로 재개 커서
// 오염 방지 회귀가드. Provider 없이 렌더하면 useSseMultiplexerContext()가 null을 반환해
// 독립 EventSource 폴백 분기를 타는 것을 이용한다(SseMultiplexerContext 기본값 null).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
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

// story #2987(선생님 실사용 지적, standalone-fallback 경로) — sse-multiplexer.test.tsx의
// "가시성 복귀 강제 재연결" 회귀가드와 동형(mux OFF일 때 이 훅이 직접 여는 EventSource도
// 같은 처방을 받아야 한다).
describe('useChatSse — 가시성 복귀 강제 재연결(#2987, standalone-fallback)', () => {
  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('임계값(3s) 이상 숨겨졌다 돌아오면 기존 커넥션을 닫고 새로 연다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    act(() => { setVisibility('visible'); });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it('임계값(3s) 미만의 짧은 전환은 재연결하지 않는다 — 처칭 방지', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });

    act(() => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    act(() => { setVisibility('visible'); });

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('강제 재연결이 열리면 onReconnect가 불린다(backfill 트리거, backoff 이력 무관)', async () => {
    const onReconnect = vi.fn();
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" onReconnect={onReconnect} />); });
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => { setVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    act(() => { setVisibility('visible'); });
    act(() => { FakeEventSource.instances[1]!.onopen?.(); });

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

// story #3081(선생님 P0 지시, standalone-fallback 경로) — sse-multiplexer.test.tsx의
// "window.focus 강제 재연결" 회귀가드와 동형. 위 #2987 스위트(visibilitychange 축)와 달리
// hidden 이력 없이 focus만으로도 재연결이 걸려야 한다.
describe('useChatSse — window.focus 강제 재연결(#3081, 가시성 축과 독립, standalone-fallback)', () => {
  it('hidden 이력 없이 window.focus만 와도 기존 커넥션을 닫고 새로 연다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => { window.dispatchEvent(new Event('focus')); });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it('짧은 시간 내 중복 focus는 두 번째부터 throttle되어 재연결하지 않는다', async () => {
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" />); });

    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(FakeEventSource.instances).toHaveLength(2); // throttle(3s) 안 — 재연결 안 함
  });

  it('focus 강제 재연결이 열리면 onReconnect가 불린다(backfill 트리거)', async () => {
    const onReconnect = vi.fn();
    await act(async () => { root.render(<Harness currentTeamMemberId="m1" onReconnect={onReconnect} />); });
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { FakeEventSource.instances[1]!.onopen?.(); });

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

// story 6ddaa086(critical, 선생님 실사고) — 「연결이 끊겼어요」 배너가 실 연결(readyState=1
// OPEN) 정상 도달 뒤에도 안 풀리던 결함. 근본원인: mux 핸들(sse-multiplexer.ts)이 #2144
// 처방으로 참조안정적인데, chat-view의 배너는 mux.connected를 getter로 직접 읽어 그 값이
// 바뀌어도 리렌더를 못 받았다(핸들 참조=Context 값이 안 바뀌므로 Provider가 소비자를
// 스킵). realtime-provider.tsx에 connected 전용 반응형 컨텍스트(SseConnectedContext)를
// 신설해 분리 — mux 핸들 자체의 참조안정성(#2144 보존)과 connected 리렌더 반응성을 둘 다
// 만족시킨다. use-team-presence.test.tsx #2144 스위트와 동일한 vi.stubEnv+resetModules+
// 동적 import 패턴(mux 공유 커넥션 경로 재현에 필수).
describe('useChatSse — mux 공유 커넥션 경로에서 connected 리렌더 반응성(story 6ddaa086)', () => {
  afterEach(() => { vi.resetModules(); });

  it('mux 최초 open(false→true)이 이 훅을 리렌더시켜 connected=true를 즉시 반영한다', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED', 'true');
    const { RealtimeProvider } = await import('@/components/realtime-provider');
    const { useChatSse: useChatSseFresh } = await import('./use-chat-sse');

    const connectedCapture = { current: false };
    function Consumer() {
      const { connected } = useChatSseFresh({ currentTeamMemberId: 'm1' });
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
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED', 'true');
    const { RealtimeProvider } = await import('@/components/realtime-provider');
    const { useChatSse: useChatSseFresh } = await import('./use-chat-sse');

    const connectedCapture = { current: false };
    function Consumer() {
      const { connected } = useChatSseFresh({ currentTeamMemberId: 'm1' });
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
