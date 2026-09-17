// @vitest-environment jsdom
//
// story #4008(E-UX-OVERHAUL·v3 셸 실시간) AC2/AC4/AC5 — 대화 열 실시간: 다른 참가자
// (에이전트) 메시지가 새로고침 없이 붙고(AC2), 내가 보낸 POST 응답과 SSE 에코가
// 겹쳐도 중복 0(id dedupe), 재연결 시 놓친 메시지를 1회 재조회로 따라잡는다(AC4).
//
// story #4008 CHANGES 2(PO 지적) — 이 컴포넌트는 더 이상 자기 useChatSse를 안 부른다
// (탭당 SSE 연결이 prod 설정에서 2개로 늘던 문제 — chat-v3-screen.tsx 한 곳으로 구독을
// 올렸다). 그래서 이 테스트는 SSE를 모의하는 대신, 부모가 넘겨줄 ref의 imperative
// handle(receiveMessage/reload)을 직접 호출해 같은 시나리오를 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { ChatV3MessagesHandle } from './chat-v3-messages';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

const INITIAL_MESSAGES = {
  data: [
    {
      id: 'm1', created_by: 'agent-1', sender_name: '담롱 온찬', sender_type: 'agent', sender_avatar_url: null,
      sender_runtime_type: null, content: '초안을 마쳤어요.', attachments: [], created_at: '2026-09-16T06:41:00Z',
      references: [], approval_target: null,
    },
  ],
};

function stub(overrides: Partial<Record<string, unknown>> = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/conversations/conv-1/messages') {
      return { ok: true, status: 200, json: async () => (overrides.messages ?? INITIAL_MESSAGES) };
    }
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(ref: React.RefObject<ChatV3MessagesHandle | null>) {
  const { ChatV3Messages } = await import('./chat-v3-messages');
  await act(async () => {
    root.render(wrap(
      <ChatV3Messages
        ref={ref}
        threadId="conv-1"
        meId="me-1"
        agentName="담롱 온찬"
        locale="ko"
        needsMe={[]}
        todayV3Enabled
        onOpenArtifactChange={() => {}}
        onWorkItemRefChange={() => {}}
      />,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ChatV3Messages — 실시간(story #4008 AC2)', () => {
  it('⭐다른 참가자(에이전트) 메시지가 새로고침 없이 붙는다(실 응답 모양 — 중첩 sender)', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    expect(container.textContent).toContain('초안을 마쳤어요');

    await act(async () => {
      ref.current?.receiveMessage({
        id: 'm2',
        conversation_id: 'conv-1',
        sender: { id: 'agent-1', name: '담롱 온찬', type: 'agent' },
        content: '검토 부탁드려요.',
        created_at: '2026-09-16T06:42:00Z',
        references: [],
      });
    });
    expect(container.textContent).toContain('검토 부탁드려요');
  });

  // story #4008 CHANGES 2 이후 — threadId 필터는 이제 chat-v3-screen.tsx가 receiveMessage를
  // 부르기 전에 담당한다(selectedId 일치 확인). 이 컴포넌트 자체는 filter 없이 받은 걸
  // 그대로 반영하는 게 계약이므로, 부모 쪽 필터는 chat-v3-screen.test.tsx가 고정한다.

  it('⭐내가 보낸 POST 응답과 SSE 에코가 겹쳐도 id로 dedupe돼 중복 렌더 0(AC2)', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'm3', created_by: 'me-1', sender_name: '나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, content: '확인했어요', attachments: [], created_at: '2026-09-16T06:44:00Z', references: [] } }),
    }));
    const input = container.querySelector('[data-testid="chat-v3-compose-input"]') as HTMLInputElement;
    const sendBtn = container.querySelector('[data-testid="chat-v3-send-action"]') as HTMLElement;
    await act(async () => {
      // jsdom + 제어 컴포넌트 — React value tracker를 우회하려면 네이티브 setter로 값을
      // 심어야 onChange가 실제로 fire한다(chat-input.test.tsx와 동일 관례).
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '확인했어요');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      sendBtn.click();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect([...container.querySelectorAll('*')].filter((el) => el.textContent === '확인했어요').length).toBeGreaterThan(0);

    // SSE가 같은 id로 에코해도(전송 응답과 실시간 이벤트가 겹치는 흔한 경합) 두 번 안 붙는다.
    await act(async () => {
      ref.current?.receiveMessage({
        id: 'm3', conversation_id: 'conv-1', sender: { id: 'me-1', name: '나', type: 'human' },
        content: '확인했어요', created_at: '2026-09-16T06:44:00Z',
      });
    });
    const bubbleCount = [...container.querySelectorAll('.inline-block')].filter((el) => el.textContent === '확인했어요').length;
    expect(bubbleCount).toBe(1);
  });
});

describe('ChatV3Messages — 재연결 따라잡기(story #4008 AC4)', () => {
  it('⭐ref.reload()를 부르면 메시지를 1회 재조회한다', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    const callsBefore = fetchMock.mock.calls.filter((c) => c[0] === '/api/conversations/conv-1/messages').length;
    expect(callsBefore).toBe(1);

    expect(typeof ref.current?.reload).toBe('function');
    await act(async () => { ref.current?.reload(); await Promise.resolve(); await Promise.resolve(); });
    const callsAfter = fetchMock.mock.calls.filter((c) => c[0] === '/api/conversations/conv-1/messages').length;
    expect(callsAfter).toBe(2);
  });
});
