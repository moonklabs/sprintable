// @vitest-environment jsdom
//
// story #4008(E-UX-OVERHAUL·v3 셸 실시간) AC2/AC4/AC5 — 대화 열 실시간: 다른 참가자
// (에이전트) 메시지가 새로고침 없이 붙고(AC2), 내가 보낸 POST 응답과 SSE 에코가
// 겹쳐도 중복 0(id dedupe), 재연결 시 놓친 메시지를 1회 재조회로 따라잡는다(AC4).
// useChatSse는 모의(chat-list-view.test.tsx와 동일 관례 — vi.hoisted 캡처, 실
// EventSource/멀티플렉서까지 안 끌고 온다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { useChatSseMock } = vi.hoisted(() => ({
  useChatSseMock: vi.fn((_opts?: unknown) => ({ connected: true, polling: false })),
}));
vi.mock('@/hooks/use-chat-sse', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-chat-sse')>('@/hooks/use-chat-sse');
  return {
    ...actual,
    useChatSse: (opts: unknown) => useChatSseMock(opts),
  };
});

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
  useChatSseMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { ChatV3Messages } = await import('./chat-v3-messages');
  await act(async () => {
    root.render(wrap(
      <ChatV3Messages
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

function lastSseOptions() {
  return useChatSseMock.mock.calls.at(-1)?.[0] as {
    onConversationMessage?: (payload: Record<string, unknown>) => void;
    onReconnect?: () => void;
    currentTeamMemberId?: string;
  } | undefined;
}

describe('ChatV3Messages — 실시간(story #4008 AC2)', () => {
  it('⭐다른 참가자(에이전트) 메시지가 새로고침 없이 붙는다(실 응답 모양 — 중첩 sender)', async () => {
    stub();
    await mount();
    expect(container.textContent).toContain('초안을 마쳤어요');

    const opts = lastSseOptions();
    expect(opts?.currentTeamMemberId).toBe('me-1');
    await act(async () => {
      opts?.onConversationMessage?.({
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

  it('⭐다른 스레드로 온 이벤트는 무시한다(threadId 불일치)', async () => {
    stub();
    await mount();
    const opts = lastSseOptions();
    await act(async () => {
      opts?.onConversationMessage?.({
        id: 'm-other',
        conversation_id: 'conv-99',
        sender: { id: 'agent-1', name: '담롱 온찬', type: 'agent' },
        content: '다른 대화 메시지',
        created_at: '2026-09-16T06:43:00Z',
      });
    });
    expect(container.textContent).not.toContain('다른 대화 메시지');
  });

  it('⭐내가 보낸 POST 응답과 SSE 에코가 겹쳐도 id로 dedupe돼 중복 렌더 0(AC2)', async () => {
    stub();
    await mount();
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
    const opts = lastSseOptions();
    await act(async () => {
      opts?.onConversationMessage?.({
        id: 'm3', conversation_id: 'conv-1', sender: { id: 'me-1', name: '나', type: 'human' },
        content: '확인했어요', created_at: '2026-09-16T06:44:00Z',
      });
    });
    const bubbleCount = [...container.querySelectorAll('.inline-block')].filter((el) => el.textContent === '확인했어요').length;
    expect(bubbleCount).toBe(1);
  });
});

describe('ChatV3Messages — 재연결 따라잡기(story #4008 AC4)', () => {
  it('⭐onReconnect가 넘어가고, 부르면 메시지를 1회 재조회한다', async () => {
    stub();
    await mount();
    const callsBefore = fetchMock.mock.calls.filter((c) => c[0] === '/api/conversations/conv-1/messages').length;
    expect(callsBefore).toBe(1);

    const opts = lastSseOptions();
    expect(typeof opts?.onReconnect).toBe('function');
    await act(async () => { opts?.onReconnect?.(); await Promise.resolve(); await Promise.resolve(); });
    const callsAfter = fetchMock.mock.calls.filter((c) => c[0] === '/api/conversations/conv-1/messages').length;
    expect(callsAfter).toBe(2);
  });
});
