// @vitest-environment jsdom
//
// story #4008(E-UX-OVERHAUL·v3 셸 실시간) AC7 CHANGES 2(PO 지적) — "탭당 SSE 연결 1개"의
// 주 증거는 소스 grep(verify-chat-v3-no-raw-eventsource.test.ts)이 아니라 실제 런타임
// 연결 개수여야 한다. 이 파일은 `useChatSse`를 모의하지 않고 실 훅을 그대로 태워,
// ChatV3Screen 트리 전체(스레드 레일+대화 열)가 <RealtimeProvider> 안에 마운트됐을 때
// `new EventSource(...)`가 정확히 1번만 불리는지를 직접 잰다.
//
// story #4698 — 멀티플렉서 «끔» 길(훅마다 독립 EventSource)은 지웠다: 스트림은 RealtimeProvider(sse-multiplexer.ts) 하나뿐이고, 이 화면은 (v3) 레이아웃에서
// 늘 Provider 안이다. 그래서 이 시험도 Provider로 감싸 «지금 열린 스트림 수»를 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { RealtimeProvider } from '@/components/realtime-provider';
import { DEFAULT_NAV_V3_FLAGS } from '@/lib/nav-v3-destinations';

// story #4018 — usePathname/useSearchParams 추가(주소 쿼리 `conversation` 딥링크).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  // story #4006 AC8 — 이 화면에 새로 물린 MobileTabBar도 usePathname()을 쓴다(app router
  // 미마운트 테스트 환경 방어, mobile-tab-bar-badge.test.tsx와 동일 관례).
  usePathname: () => '/chat',
  useSearchParams: () => new URLSearchParams(),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener() { /* no-op — 이 테스트는 개수만 잰다, 이벤트 배선은 다른 테스트 몫 */ }
  removeEventListener() {}
  close() { this.closed = true; }
}

const fetchMock = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <RealtimeProvider currentTeamMemberId="me-1">{node}</RealtimeProvider>
    </NextIntlClientProvider>
  );
}

const ME = { data: { id: 'me-1', project_id: 'proj-1', role: 'owner' } };
const THREADS = {
  data: [
    {
      id: 'conv-1',
      participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'agent-1', name: '담롱 온찬', type: 'agent' }],
      latest_message: { content: '발행 승인을 올려요', created_at: '2026-09-16T06:41:00Z' },
      unread_count: 0,
    },
  ],
};
const MESSAGES = {
  data: [
    {
      id: 'm1', created_by: 'agent-1', sender_name: '담롱 온찬', sender_type: 'agent', sender_avatar_url: null,
      sender_runtime_type: null, content: '초안을 마쳤어요.', attachments: [], created_at: '2026-09-16T06:41:00Z',
      references: [], approval_target: null,
    },
  ],
};
const EMPTY_TODAY = { data: { needs_me: [], needs_me_count: 0, agent_progress: [], published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } } } };

function stub() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/me') return { ok: true, status: 200, json: async () => ME };
    if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => THREADS };
    if (url === '/api/conversations/conv-1/messages') return { ok: true, status: 200, json: async () => MESSAGES };
    if (url === '/api/today') return { ok: true, status: 200, json: async () => EMPTY_TODAY };
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  FakeEventSource.instances = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChatV3Screen — 실 EventSource 연결 개수(story #4008 AC7 · #4698 늘 한 스트림)', () => {
  it('⭐스레드 레일+대화 열이 함께 마운트돼도 EventSource는 정확히 1개만 열린다', async () => {
    stub();
    const { ChatV3Screen } = await import('./chat-v3-screen');
    await act(async () => { root.render(wrap(<ChatV3Screen flags={{ ...DEFAULT_NAV_V3_FLAGS, todayV3Enabled: true }} />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // 화면이 실제로 스레드+메시지까지 렌더됐는지(연결 개수 판정이 무의미한 빈 렌더가
    // 아닌지) 먼저 확인 — 두 인스턴스 다 마운트된 상태에서 잰 개수여야 의미가 있다.
    expect(container.querySelector('[data-testid="chat-v3-thread-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('초안을 마쳤어요');

    // story #4008 — currentTeamMemberId가 처음엔 undefined(me 로딩 前)였다가 로드 후 값이 생기는 길이 있다. story #4797부터 값이 없는 동안은 스트림을
    // 아예 열지 않고(400 재시도 루프 0) 값이 생기면 그때 하나를 연다 — 이 시험의 Provider는 처음부터 값을 받는다. 그래도 단언 대상은
    // "생성된 적 있는 횟수"가 아니라 "지금 열려 있는 연결 수"다(전환 lifecycle이 닫고 여는 것을 허용).
    const openInstances = FakeEventSource.instances.filter((i) => !i.closed);
    expect(openInstances.length).toBe(1);
  });
});
