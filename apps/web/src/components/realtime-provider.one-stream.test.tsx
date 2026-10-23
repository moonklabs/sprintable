// @vitest-environment jsdom
//
// story #4698 — 한 화면이 presence · chat · notification 셋을 다 구독해도 열린 이벤트 스트림은 **1개**다.
// 멀티플렉스를 «끔»으로 두던 시절엔 훅마다 독립 EventSource가 열려 탭당 3~4개였고, 크롬이 끝나지 않는 스트림 3개 이상에서 낮은 우선순위 요청(대화 탭
// 청크 · 프리패치)을 15~20초 붙잡았다(4698 에뮬 실측). 실 훅을 모의하지 않고 실 Provider로 감싸 «지금 열려 있는 EventSource 수»를 직접 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RealtimeProvider } from '@/components/realtime-provider';
import { useTeamPresence } from '@/components/presence/use-team-presence';
import { useChatSse } from '@/hooks/use-chat-sse';
import { useSseNotifications } from '@/hooks/use-sse-notifications';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  readyState = 0;
  constructor(public url: string, _opts?: unknown) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: (e: MessageEvent) => void) { (this.listeners[type] ??= []).push(cb); }
  removeEventListener() {}
  close() { this.closed = true; }
  emit(type: string, data = '{}') { for (const cb of this.listeners[type] ?? []) cb({ data, lastEventId: '' } as MessageEvent); }
}
const open = () => FakeEventSource.instances.filter((i) => !i.closed);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = { chat: [] as unknown[], notif: [] as unknown[], extra: [] as Array<[string, unknown]> };

function ThreeChannels() {
  useTeamPresence(true);
  useChatSse({ onConversationMessage: (p) => calls.chat.push(p) });
  useSseNotifications({
    onNotification: (n) => calls.notif.push(n),
    extraEventNames: ['story.status_changed'],
    onExtraEvent: (name, data) => calls.extra.push([name, data]),
  });
  return null;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  calls.chat = []; calls.notif = []; calls.extra = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('story #4698 — 세 채널 구독 = 열린 스트림 1개', () => {
  it('⭐RealtimeProvider 안에서 presence · chat · notification을 다 구독해도 열린 EventSource는 정확히 1개다', async () => {
    await act(async () => { root.render(<RealtimeProvider currentTeamMemberId="m1"><ThreeChannels /></RealtimeProvider>); await Promise.resolve(); });
    expect(open().length).toBe(1);
    expect(FakeEventSource.instances.length).toBe(1); // 지금 열린 수뿐 아니라 만들어진 수도 1 — 만들었다 닫는 흔들림 0
  });

  it('⭐그 한 스트림의 URL에 member_id가 실린다 — 백엔드는 JWT 세션이 member_id 없이 열면 400으로 거절한다(까디르 핀)', async () => {
    await act(async () => { root.render(<RealtimeProvider currentTeamMemberId="m1"><ThreeChannels /></RealtimeProvider>); await Promise.resolve(); });
    const url = new URL(open()[0]!.url, 'http://localhost');
    expect(url.pathname).toBe('/api/event-stream');
    expect(url.searchParams.get('member_id')).toBe('m1');
  });

  it('그 한 스트림이 세 채널의 이벤트를 다 배달한다(이름별 구독이 실제로 걸려 있다)', async () => {
    await act(async () => { root.render(<RealtimeProvider currentTeamMemberId="m1"><ThreeChannels /></RealtimeProvider>); await Promise.resolve(); });
    const es = open()[0]!;
    const before = fetchMock.mock.calls.length; // presence 초기 스냅샷
    await act(async () => { es.emit('conversation.message_created', JSON.stringify({ id: 'e1', conversation_id: 'c1' })); });
    expect(calls.chat.length).toBe(1);
    await act(async () => { es.onmessage?.({ data: JSON.stringify({ id: 'n1', event_type: 'x', source_entity_type: null, source_entity_id: null, payload: null, read_at: null, created_at: 'now' }), lastEventId: '' } as MessageEvent); });
    expect(calls.notif.length).toBe(1);
    await act(async () => { es.emit('story.status_changed', JSON.stringify({ story_id: 's1' })); });
    expect(calls.extra).toEqual([['story.status_changed', { story_id: 's1' }]]);
    vi.useFakeTimers();
    await act(async () => { es.emit('presence'); vi.advanceTimersByTime(400); });
    vi.useRealTimers();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before); // presence 이벤트 → refetch
  });

  it('⭐Provider 밖에서는 스트림이 하나도 안 열린다 — 훅이 몰래 독립 EventSource로 폴백하지 않는다', async () => {
    await act(async () => { root.render(<ThreeChannels />); await Promise.resolve(); });
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it('같은 Provider 아래 소비자가 몇 곳이든(둘째 화면이 더 붙어도) 스트림은 1개를 유지한다', async () => {
    await act(async () => {
      root.render(<RealtimeProvider currentTeamMemberId="m1"><ThreeChannels /><ThreeChannels /></RealtimeProvider>);
      await Promise.resolve();
    });
    expect(open().length).toBe(1);
  });
});
