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
        todayHref="/today"
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

  // story #4008 CHANGES(유나 design·PO 지적, 2026-09-17) — reload()가 setMessages(null)부터
  // 하면 재연결마다 화면이 스켈레톤으로 순간 비워진다(레일은 성공 때만 교체해 안 비워지는
  // 것과 대조). 뮤테이션 셀프체크: loadMessages의 `if (!options?.silent)` 가드를 없애 매번
  // setMessages(null)이 돌게 하면 이 테스트가 RED로 뒤집힘(수동 재현·원복 완료).
  it('⭐reload() 도중에도 기존 메시지가 스켈레톤 없이 DOM에 그대로 남는다', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    expect(container.textContent).toContain('초안을 마쳤어요');
    expect(container.querySelector('[data-testid="chat-v3-messages-loading"]')).toBeNull();

    // fetch를 아직 안 풀리는 pending promise로 바꿔 "재조회 진행 中" 구간을 관찰한다.
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );
    act(() => { ref.current?.reload(); });

    // 재조회가 아직 안 끝났어도(pending) 기존 메시지가 스켈레톤으로 안 바뀌어야 한다.
    expect(container.textContent).toContain('초안을 마쳤어요');
    expect(container.querySelector('[data-testid="chat-v3-messages-loading"]')).toBeNull();

    await act(async () => {
      resolveFetch({ ok: true, status: 200, json: async () => INITIAL_MESSAGES });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).toContain('초안을 마쳤어요');
  });

  it('⭐reload() 재조회가 실패해도 기존 메시지를 그대로 둔다(에러 상태로 안 바꿈)', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    expect(container.textContent).toContain('초안을 마쳤어요');

    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await act(async () => { ref.current?.reload(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('초안을 마쳤어요');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // story #4008 CHANGES(PO 지적 ①, 2026-09-17) — reload()가 부른 loadMessages의 cancelled
  // 플래그는 imperative 호출 경로에선 아무도 안 봐준다. 뮤테이션 셀프체크: activeThreadIdRef
  // 대조를 없애면(예전 코드로 되돌리면) 이 테스트가 RED로 뒤집힘(수동 재현·원복 완료).
  it('⭐재조회 진행 中 대화를 전환하면, 늦게 온 이전 대화 응답이 새 대화 화면에 안 섞인다', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    expect(container.textContent).toContain('초안을 마쳤어요');

    // conv-1 재조회를 pending으로 묶어둔다(reload).
    let resolveConv1Reload: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveConv1Reload = resolve; }),
    );
    act(() => { ref.current?.reload(); });

    // conv-2로 전환(즉시 응답하는 별도 스텁) — 이 전환의 정상 로드가 화면을 채운다.
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/conversations/conv-2/messages') {
        return {
          ok: true, status: 200,
          json: async () => ({
            data: [{
              id: 'm-conv2', created_by: 'agent-1', sender_name: '담롱 온찬', sender_type: 'agent',
              sender_avatar_url: null, sender_runtime_type: null, content: 'conv-2 전용 메시지',
              attachments: [], created_at: '2026-09-17T00:00:00Z', references: [], approval_target: null,
            }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
    const { ChatV3Messages } = await import('./chat-v3-messages');
    await act(async () => {
      root.render(wrap(
        <ChatV3Messages
          ref={ref} threadId="conv-2" meId="me-1" agentName="담롱 온찬" locale="ko" needsMe={[]}
          todayV3Enabled todayHref="/today" onOpenArtifactChange={() => {}} onWorkItemRefChange={() => {}}
        />,
      ));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).toContain('conv-2 전용 메시지');

    // 이제야 늦게 도착한 conv-1의 stale 응답 — conv-2 화면에 섞이면 안 된다.
    await act(async () => {
      resolveConv1Reload({ ok: true, status: 200, json: async () => ({ data: [{ ...INITIAL_MESSAGES.data[0], content: 'stale conv-1 응답' }] }) });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).not.toContain('stale conv-1 응답');
    expect(container.textContent).toContain('conv-2 전용 메시지');
  });

  // story #4008 CHANGES(PO 지적 ②, 2026-09-17) — silent 재조회가 통째 교체면, 재조회
  // 진행 中 도착한 실시간 메시지(receiveMessage)가 그 스냅숏(조회 시작 시점 기준)보다
  // 최신이라 fetch 응답엔 없어 통째 교체 때 사라진다(AC4 「따라잡기」가 오히려 잃는 역설).
  // 뮤테이션 셀프체크: id 병합을 setMessages(fetched) 통째 교체로 되돌리면 이 테스트가
  // RED로 뒤집힘(수동 재현·원복 완료).
  it('⭐reload() 진행 中 도착한 실시간 메시지는 재조회 응답이 늦게 와도 안 사라진다(id 병합)', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    expect(container.textContent).toContain('초안을 마쳤어요');

    let resolveReload: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveReload = resolve; }),
    );
    act(() => { ref.current?.reload(); });

    // 재조회가 아직 안 끝난 사이 실시간 메시지가 먼저 도착.
    act(() => {
      ref.current?.receiveMessage({
        id: 'm-live', conversation_id: 'conv-1', sender: { id: 'agent-1', name: '담롱 온찬', type: 'agent' },
        content: '재조회 中 실시간 도착', created_at: '2026-09-16T06:43:00Z', references: [],
      });
    });
    expect(container.textContent).toContain('재조회 中 실시간 도착');

    // 재조회 응답이 뒤늦게 도착(그 시점 스냅숏이라 실시간 메시지는 안 들어있음).
    await act(async () => {
      resolveReload({ ok: true, status: 200, json: async () => INITIAL_MESSAGES });
      await Promise.resolve(); await Promise.resolve();
    });

    // 둘 다 남아 있어야 한다(교체가 아니라 병합) — 중복도 0.
    expect(container.textContent).toContain('초안을 마쳤어요');
    expect(container.textContent).toContain('재조회 中 실시간 도착');
    const liveCount = [...container.querySelectorAll('*')].filter((el) => el.textContent === '재조회 中 실시간 도착').length;
    expect(liveCount).toBeGreaterThan(0);
  });
});

describe('ChatV3Messages — 대화 전환 스켈레톤(story #4008 CHANGES)', () => {
  it('⭐threadId가 바뀌면(대화 전환) 스켈레톤이 뜬다(reload()와 대조되는 축)', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await mount(ref);
    expect(container.textContent).toContain('초안을 마쳤어요');

    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );
    const { ChatV3Messages } = await import('./chat-v3-messages');
    act(() => {
      root.render(wrap(
        <ChatV3Messages
          ref={ref}
          threadId="conv-2"
          meId="me-1"
          agentName="담롱 온찬"
          locale="ko"
          needsMe={[]}
          todayV3Enabled
          todayHref="/today"
          onOpenArtifactChange={() => {}}
          onWorkItemRefChange={() => {}}
        />,
      ));
    });

    expect(container.querySelector('[data-testid="chat-v3-messages-loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain('초안을 마쳤어요');

    await act(async () => {
      resolveFetch({ ok: true, status: 200, json: async () => ({ data: [] }) });
      await Promise.resolve(); await Promise.resolve();
    });
  });
});

// story #4028(E-UX-OVERHAUL·v3 셸) AC1/AC3/AC4 — 주소 `?compose=`(컴패니언 첫 지시)를
// 마운트 1회만 입력창에 미리 채운다. 사람이 직접 보낸다(전송 0). 상한(2000, 4021 미러)
// 초과면 자르지 않고 안내만. 값이 없으면 입력창 빈 채(음성 대조).
describe('ChatV3Messages — 첫 지시 미리 채우기(story #4028)', () => {
  async function mountCompose(initialCompose: string | null) {
    const { ChatV3Messages } = await import('./chat-v3-messages');
    await act(async () => {
      root.render(wrap(
        <ChatV3Messages
          ref={createRef<ChatV3MessagesHandle>()}
          threadId="conv-1"
          meId="me-1"
          agentName="담롱 온찬"
          locale="ko"
          needsMe={[]}
          todayV3Enabled
          todayHref="/today"
          onOpenArtifactChange={() => {}}
          onWorkItemRefChange={() => {}}
          initialCompose={initialCompose}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('compose 값이 입력창에 미리 채워진다(AC1)', async () => {
    stub();
    await mountCompose('배포 상태 알려줘');
    const input = container.querySelector('[data-testid="chat-v3-compose-input"]') as HTMLInputElement;
    expect(input.value).toBe('배포 상태 알려줘');
    expect(container.querySelector('[data-testid="chat-v3-compose-too-long"]')).toBeNull();
  });

  it('미리 채워도 전송은 0 — 사람이 직접 누른다(AC1/AC5)', async () => {
    stub();
    await mountCompose('배포 상태 알려줘');
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');
    expect(posts.length).toBe(0);
  });

  it('compose 없음(null)이면 입력창은 빈 채·안내 0(음성 대조)', async () => {
    stub();
    await mountCompose(null);
    const input = container.querySelector('[data-testid="chat-v3-compose-input"]') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(container.querySelector('[data-testid="chat-v3-compose-too-long"]')).toBeNull();
  });

  it('상한(2000) 초과면 자르지 않고 입력창은 빈 채 + 안내(AC3)', async () => {
    stub();
    await mountCompose('x'.repeat(2001));
    const input = container.querySelector('[data-testid="chat-v3-compose-input"]') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(container.querySelector('[data-testid="chat-v3-compose-too-long"]')).not.toBeNull();
  });

  it('안내가 뜬 뒤 사람이 입력을 시작하면 안내가 사라진다', async () => {
    stub();
    await mountCompose('x'.repeat(2001));
    expect(container.querySelector('[data-testid="chat-v3-compose-too-long"]')).not.toBeNull();
    const input = container.querySelector('[data-testid="chat-v3-compose-input"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '짧게 다시');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="chat-v3-compose-too-long"]')).toBeNull();
  });
});

// story #4028 CHANGES 2(PO 지적) — 이 컴포넌트는 key가 없어 대화를 바꿔도 remount되지
// 않는다(사람이 쓰던 초안 유지 목적). 그런데 «기계가 특정 대화를 겨냥해 넣은» 첫 지시가
// 손 안 탄 채 다른 대화로 새면 그 대화에서 잘못 전송될 수 있다 → 시드 대화 밖으로 바뀌면
// 시드분만 비운다(사람이 손댄 초안은 유지). 전송은 여전히 0.
describe('ChatV3Messages — 대화 전환 시 시드 처리(story #4028 CHANGES 2)', () => {
  async function renderAt(ref: React.RefObject<ChatV3MessagesHandle | null>, threadId: string, initialCompose?: string | null) {
    const { ChatV3Messages } = await import('./chat-v3-messages');
    await act(async () => {
      root.render(wrap(
        <ChatV3Messages
          ref={ref}
          threadId={threadId}
          meId="me-1"
          agentName="담롱 온찬"
          locale="ko"
          needsMe={[]}
          todayV3Enabled
          todayHref="/today"
          onOpenArtifactChange={() => {}}
          onWorkItemRefChange={() => {}}
          initialCompose={initialCompose}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }
  const input = () => container.querySelector('[data-testid="chat-v3-compose-input"]') as HTMLInputElement;
  function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('손 안 탄 시드는 다른 대화로 바뀌면 비워진다(다른 대화로 전송 방지)', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await renderAt(ref, 'conv-1', 'conv-1 에이전트용 첫 지시');
    expect(input().value).toBe('conv-1 에이전트용 첫 지시');
    await renderAt(ref, 'conv-2', 'conv-1 에이전트용 첫 지시'); // 전환(remount 아님)
    expect(input().value).toBe('');
  });

  it('사람이 손댄 초안은 대화를 바꿔도 유지된다', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await renderAt(ref, 'conv-1', '기계 시드');
    await act(async () => { typeInto(input(), '사람이 직접 쓴 초안'); });
    expect(input().value).toBe('사람이 직접 쓴 초안');
    await renderAt(ref, 'conv-2', '기계 시드'); // 전환
    expect(input().value).toBe('사람이 직접 쓴 초안'); // 사람 글자는 유지
  });

  it('시드→전환 과정에서 전송(POST)은 0', async () => {
    stub();
    const ref = createRef<ChatV3MessagesHandle>();
    await renderAt(ref, 'conv-1', '기계 시드');
    await renderAt(ref, 'conv-2', '기계 시드');
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');
    expect(posts.length).toBe(0);
  });
});

// [SID:4311 PR 3] 발신자 줄 — 같은 이름 서로 다른 발신자 둘이면 «· ID 앞 8자»(발신자 id마다 한 번) · 내 메시지는 «나»라 셈에서 뺀다
// (내 이름이 남의 줄에 꼬리를 만들지 않음).
describe('ChatV3Messages — 발신자 동명이인([SID:4311 PR 3])', () => {
  it('«송윤재» 둘 = 줄마다 id 앞 8자 · 같은 사람 두 줄 = 같은 꼬리 · 나와 같은 이름의 남 = 꼬리 없음', async () => {
    // 실 응답 모양 — 발신자는 중첩 sender(normalizeToMessage가 sender_name으로 푼다).
    const msg = (id: string, created_by: string, sender_name: string) => ({
      id, sender: { id: created_by, name: sender_name, type: 'human' },
      content: `본문 ${id}`, attachments: [], created_at: '2026-09-16T06:41:00Z', references: [], approval_target: null,
    });
    stub({ messages: { data: [
      msg('m1', 'e75ca548-1', '송윤재'),
      msg('m2', '2fd14616-2', '송윤재'),
      msg('m3', 'e75ca548-1', '송윤재'),
      msg('m4', 'me-1', '안나'),
      msg('m5', 'other-anna', '안나'),
    ] } });
    await mount(createRef<ChatV3MessagesHandle>());
    const labels = [...container.querySelectorAll('p.mb-1.text-xs')].map((el) => el.textContent);
    expect(labels).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '송윤재 · e75ca548', koMessages.chatV3.meLabel, '안나']);
  });
});
