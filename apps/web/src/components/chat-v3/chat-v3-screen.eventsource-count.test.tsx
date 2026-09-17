// @vitest-environment jsdom
//
// story #4008(E-UX-OVERHAUL·v3 셸 실시간) AC7 CHANGES 2(PO 지적) — "탭당 SSE 연결 1개"의
// 주 증거는 소스 grep(verify-chat-v3-no-raw-eventsource.test.ts)이 아니라 실제 런타임
// 연결 개수여야 한다: 멀티플렉서(SSE_MULTIPLEX_ENABLED)가 꺼진 설정(prod 기본값,
// cloud-build.yml)에서는 `useChatSse` 호출마다 독립 `EventSource`가 열린다(use-chat-sse.ts
// 폴백 경로) — 훅을 몇 곳에서 부르느냐가 그대로 연결 개수다. 이 파일은 `useChatSse`를
// 모의하지 않고 실 훅을 그대로 태워, ChatV3Screen 트리 전체(스레드 레일+대화 열)가
// 마운트됐을 때 `new EventSource(...)`가 정확히 1번만 불리는지를 직접 잰다.
//
// SSE_MULTIPLEX_ENABLED는 모듈 로드 시점에 `process.env['NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED']`
// 를 읽어 고정되므로(realtime-provider.tsx), 이 값을 세팅 안 한 채(undefined → false) 도는
// 이 테스트 프로세스는 그 자체로 prod와 동일한 "멀티플렉서 없음" 경로를 자연히 재현한다 —
// RealtimeProvider로 감쌀 필요조차 없다(mux=null인 폴백 경로가 정확히 이 상태).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DEFAULT_NAV_V3_FLAGS } from '@/lib/nav-v3-destinations';

// story #4018 — usePathname/useSearchParams 추가(주소 쿼리 `conversation` 딥링크).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
      {node}
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

describe('ChatV3Screen — 실 EventSource 연결 개수(story #4008 AC7, 멀티플렉서 OFF=prod 기본)', () => {
  it('⭐스레드 레일+대화 열이 함께 마운트돼도 EventSource는 정확히 1개만 열린다', async () => {
    stub();
    const { ChatV3Screen } = await import('./chat-v3-screen');
    await act(async () => { root.render(wrap(<ChatV3Screen flags={{ ...DEFAULT_NAV_V3_FLAGS, todayV3Enabled: true }} />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // 화면이 실제로 스레드+메시지까지 렌더됐는지(연결 개수 판정이 무의미한 빈 렌더가
    // 아닌지) 먼저 확인 — 두 인스턴스 다 마운트된 상태에서 잰 개수여야 의미가 있다.
    expect(container.querySelector('[data-testid="chat-v3-thread-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('초안을 마쳤어요');

    // story #4008 — currentTeamMemberId가 처음엔 undefined(me 로딩 前)였다가 로드 후
    // 값이 생기면, useChatSse 내부가 그 변화로 재연결한다(memberId 없이 연 첫 연결을
    // 닫고 실 id로 다시 연다 — 의도된 lifecycle, use-chat-sse.ts 자체 주석 참고). 그래서
    // "생성된 적 있는 횟수"가 아니라 "지금 열려 있는 연결 수"가 AC7의 실제 단언 대상이다.
    const openInstances = FakeEventSource.instances.filter((i) => !i.closed);
    expect(openInstances.length).toBe(1);
  });
});
