// @vitest-environment jsdom
//
// story #2262 PR②(2026-08-08, 카디르 QA 지적·PR#2911에 곁들임) — ThreadPanel이 자기
// (스레드 답글) messages를 useEntityStatusBatchFetch에 실제로 넘기는지 아무 테스트도
// 안 잡고 있었다. use-entity-status-batch.test.tsx는 훅 자체(순수 harness)만 검증해
// ThreadPanel 컴포넌트가 그 훅을 «제대로 배선했는지»는 뮤테이션으로 배선을 끊어도
// 아무 테스트도 안 걸렸다 — 라이브 코드는 정확했지만 미래 리팩터로 이 배선이 끊기면
// "스레드 고착 스피너"(#2262 PR② 본체가 고친 바로 그 결함)가 조용히 재발해도 CI가
//못 잡는 사각이었다. 이 테스트는 ThreadPanel을 실제로 마운트해 그 배선을 왕복 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ThreadPanel } from './thread-panel';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import type { EntityStatusFetchState } from './entity-status-labels';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1' }),
}));

// story #2671 — 참조 링크 하나뿐인 문단은 EmbedCard(카드)로 렌더된다. EmbedCard doc 클릭
// 핸들러가 useRouter()를 쓰므로 라우터 컨텍스트 없이 렌더하면 죽는다(같은 mock을
// chat-bubble.test.tsx에서도 씀).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

// story #4430 — the reply send is driven through ChatInput's onSend (the real input's typing isn't what these tests watch).
vi.mock('./chat-input', () => ({
  ChatInput: ({ onSend }: { onSend: (content: string) => Promise<void> | void }) => (
    <button type="button" data-testid="mock-send" onClick={() => { void onSend('회의록 올렸어요.'); }}>send</button>
  ),
}));

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const TASK_ID = '33333333-3333-3333-3333-333333333333';

const parentMessage: ChatMessage = {
  id: 'parent-1',
  memo_id: 'conv-1',
  created_by: 'agent-1',
  sender_name: '오르테가',
  sender_type: 'agent',
  sender_avatar_url: null,
  sender_runtime_type: null,
  content: '원본 메시지',
  attachments: [],
  created_at: '2026-08-08T00:00:00.000Z',
};

// ThreadPanel의 own state(requestedEntityStatusKeysRef·setEntityStatusByKey)를 실제로
// 소유하는 하니스 — chat-view.tsx의 역할을 흉내낸다(props로 내려주는 쪽).
function Harness() {
  const [entityStatusByKey, setEntityStatusByKey] = useState<Record<string, EntityStatusFetchState>>({});
  const requestedKeysRef = useRef<Set<string>>(new Set());
  return (
    <ThreadPanel
      parentMessage={parentMessage}
      conversationId="conv-1"
      currentTeamMemberId="member-1"
      projectId="proj-1"
      onClose={() => {}}
      entityStatusByKey={entityStatusByKey}
      requestedEntityStatusKeysRef={requestedKeysRef}
      setEntityStatusByKey={setEntityStatusByKey}
    />
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom엔 scrollIntoView 구현이 없다 — ThreadPanel의 "로드 후 바닥 스크롤" 이펙트가
  // 이 테스트의 관심사가 아니므로 무해하게 스텁만 한다.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('ThreadPanel — 스레드 답글 전용 참조가 실제로 배치조회 훅에 넘어간다(#2262 PR② 배선 왕복)', () => {
  it('스레드 답글에서만 처음 보이는 참조가 resolved로 채워져 칩에 번역된 상태가 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages?thread_id=')) {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: 'reply-1',
              created_by: 'agent-2',
              sender: { id: 'agent-2', name: '유나', type: 'agent' },
              content: `[작업 A](entity:task:${TASK_ID})`,
              created_at: '2026-08-08T00:01:00.000Z',
              references: [{ target_type: 'task', target_id: TASK_ID }],
            }],
          }),
        };
      }
      if (url.includes('/api/tasks?ids=')) {
        expect(url).toContain(TASK_ID);
        return { ok: true, json: async () => ({ data: [{ id: TASK_ID, status: 'in-progress' }] }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));

    await act(async () => {
      root.render(wrap(<Harness />));
    });
    await flush();

    expect(container.textContent).toContain('진행 중');
    expect(container.textContent).not.toContain('아직 모름');
  });
});

// story #2911(S2e①/R4) — 좌측 rail(원 메시지→답글 잇는 시각선) 회귀가드.
describe('ThreadPanel — story #2911 좌측 rail(R4 위계 시각화)', () => {
  it('원본 메시지 블록과 답글 목록 wrapper 둘 다 border-l-2(같은 rail 토큰)를 갖는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages?thread_id=')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'reply-1', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 1', created_at: '2026-08-08T00:01:00.000Z' },
              { id: 'reply-2', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 2(같은 발신자 — 그룹핑)', created_at: '2026-08-08T00:02:00.000Z' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));

    await act(async () => {
      root.render(wrap(<Harness />));
    });
    await flush();

    // story 4887 (UI-4 screen PR · the approved thread) — no left rail any more: the original sits at the top as the thread's subject and the replies are PLAIN ROWS (no bubble) under it
    expect(container.querySelectorAll('.border-l-2.border-border')).toHaveLength(0);
    expect(container.querySelector('[data-testid="thread-original"]')).not.toBeNull();
    const rows = container.querySelectorAll('[data-testid="thread-replies"] [data-testid="chat-bubble-text"]');
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.getAttribute('data-bubble'), 'every reply reads as a plain row').toBe('plain');
    expect(container.textContent).toContain('답글 1');
    expect(container.textContent).toContain('답글 2(같은 발신자 — 그룹핑)');
  });
});

// story 4887 (UI-4 screen PR · the approved thread) — the thread head is ONE line: «스레드» at the left, «{what it is about} · N개의 답글» at the right, a close button; the phone also has a back arrow.
// (It replaces the story #2911 chip breadcrumb «대화 › 원 메시지 요약»: the original message itself sits right under the head now.)
describe('ThreadPanel — the thread head (story 4887 · approved layout)', () => {
  async function mountWith(parent: ChatMessage, replies: unknown[] = [], onClose: () => void = () => {}) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: replies }) })));
    await act(async () => {
      root.render(wrap(<ThreadPanel parentMessage={parent} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={onClose} />));
    });
    await flush();
  }
  const head = () => container.querySelector('[data-testid="thread-head"]') as HTMLElement;

  it('⭐ the head says «스레드» (an h2) and, at the right, what the thread is about and how many replies it has', async () => {
    await mountWith(parentMessage);
    expect(head().querySelector('h2')?.textContent).toBe('스레드'); // reverted (the chip breadcrumb) → null
    expect(container.querySelector('[data-testid="thread-meta"]')?.textContent).toBe('메시지 · 0개의 답글');
  });

  it('the count follows the replies; an approval request names itself', async () => {
    const replies = [
      { id: 'r1', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 1', created_at: '2026-08-08T00:01:00.000Z' },
      { id: 'r2', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 2', created_at: '2026-08-08T00:02:00.000Z' },
    ];
    await mountWith({ ...parentMessage, approval_target: { work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] } } as ChatMessage, replies);
    expect(container.querySelector('[data-testid="thread-meta"]')?.textContent).toBe('결재 요청 · 2개의 답글');
  });

  it('the original message is under the head, as the subject — no «원본 메시지» label, no summary chip in the head', async () => {
    await mountWith(parentMessage);
    expect(container.querySelector('[data-testid="thread-original"]')?.textContent).toContain('원본 메시지'); // the message itself
    expect(head().textContent).not.toContain('원본 메시지');
    expect(container.textContent).not.toContain('›');
  });

  it('⭐ the close button and the phone back arrow both call onClose', async () => {
    const onClose = vi.fn();
    await mountWith(parentMessage, [], onClose);
    const close = head().querySelector('button[aria-label="스레드 닫기"]') as HTMLButtonElement | null ?? Array.from(head().querySelectorAll('button')).find((b) => /닫기|close/i.test(b.getAttribute('aria-label') ?? '')) as HTMLButtonElement;
    expect(close).toBeTruthy();
    await act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    const back = container.querySelector('[data-testid="thread-back"]') as HTMLButtonElement;
    expect(back.className).toContain('lg:hidden'); // phone only
    await act(async () => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// 2026-08-24(선생님 리포트) — 답글을 읽어도 GNB/리스트 unread 배지 (2)가 안 꺼지는 버그 회귀가드.
// 원인: ThreadPanel이 mark-read(POST .../read)를 한 번도 호출하지 않았다(chat-view.tsx#markRead가
// top-level 메시지에만 물려있었음). chat-list-view.tsx#applyConversationMessageUpdate는 parent_id
// 구분 없이 모든 conversation.message_created(스레드 답글 포함)에서 unread_count를 올리므로,
// 답글을 읽어도 내려갈 방법이 없었다.
describe('ThreadPanel — 답글 열람 시 mark-read(onMarkRead) 배선(2026-08-24 뱃지 고착 fix)', () => {
  it('로드 완료 시 최신 답글의 created_at으로 onMarkRead를 호출한다', async () => {
    const onMarkRead = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages?thread_id=')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'reply-1', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 1', created_at: '2026-08-08T00:01:00.000Z' },
              { id: 'reply-2', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 2', created_at: '2026-08-08T00:02:00.000Z' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} />,
      ));
    });
    await flush();

    expect(onMarkRead).toHaveBeenCalledWith('2026-08-08T00:02:00.000Z');
  });

  it('답글이 없으면 parentMessage.created_at으로 onMarkRead를 호출한다(원 메시지만 열람)', async () => {
    const onMarkRead = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} />,
      ));
    });
    await flush();

    expect(onMarkRead).toHaveBeenCalledWith(parentMessage.created_at);
  });

  it('패널이 열린 채로 신규 답글(incomingMessage)이 도착하면 그 created_at으로 onMarkRead를 재호출한다', async () => {
    const onMarkRead = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} />,
      ));
    });
    await flush();
    onMarkRead.mockClear();

    const incoming: ChatMessage = {
      id: 'reply-live',
      memo_id: 'conv-1',
      created_by: 'agent-3',
      sender_name: '카디르',
      sender_type: 'agent',
      sender_avatar_url: null,
      sender_runtime_type: null,
      content: '실시간 답글',
      attachments: [],
      created_at: '2026-08-08T00:05:00.000Z',
      parent_id: 'parent-1',
    };

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} incomingMessage={incoming} />,
      ));
    });
    await flush();

    expect(onMarkRead).toHaveBeenCalledWith('2026-08-08T00:05:00.000Z');
  });
});

// story #4182 — an internal HTML comment never shows. (The head's summary chip it first guarded is gone — story 4887's approved thread head — so the check follows the original message block.)
describe('ThreadPanel — HTML 주석 마커는 보이지 않는다(story #4182)', () => {
  it('원 메시지 본문의 <!-- … --> 마커가 스레드 어디에도 안 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    const commented = { ...parentMessage, content: '<!-- linear-comment-id: abc-123 -->\n\n원본 메시지' };
    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={commented} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} />,
      ));
    });
    await flush();
    const original = container.querySelector('[data-testid="thread-original"]')!;
    expect(container.textContent).not.toContain('<!--');
    expect(original.textContent).toContain('원본 메시지');
  });
});

// [SID:4311 PR 3] 원본 + 답글 한 목록의 발신자 — 같은 이름 서로 다른 발신자 둘이면 «· ID 앞 8자»(발신자 id마다 한 번) · 내 메시지는 «나»라
// 셈에서 뺀다(나와 같은 이름의 남에게 꼬리를 만들지 않음).
describe('ThreadPanel — 발신자 동명이인([SID:4311 PR 3])', () => {
  it('원본 «송윤재»와 답글 «송윤재»(다른 사람)는 꼬리로 갈림 · 같은 사람은 같은 꼬리 · 나와 같은 이름의 남 = 꼬리 없음', async () => {
    const reply = (id: string, sid: string, name: string, at: string) => ({ id, created_by: sid, sender: { id: sid, name, type: 'human' }, content: `답글 ${id}`, created_at: at });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages?thread_id=')) {
        return { ok: true, json: async () => ({ data: [
          reply('r1', '2fd14616-2', '송윤재', '2026-08-08T00:01:00.000Z'),
          reply('r2', 'e75ca548-1', '송윤재', '2026-08-08T00:02:00.000Z'),
          reply('r3', 'member-1', '안나', '2026-08-08T00:03:00.000Z'),
          reply('r4', 'other-anna', '안나', '2026-08-08T00:04:00.000Z'),
        ] }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const parent = { ...parentMessage, created_by: 'e75ca548-1', sender_name: '송윤재', sender_type: 'human' };
    await act(async () => {
      root.render(wrap(<ThreadPanel parentMessage={parent} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} />));
    });
    await flush();
    const names = [...container.querySelectorAll('span.text-editorial-meta.font-medium')].map((el) => el.textContent).filter((n) => n !== koMessages.chats.you);
    expect(names).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '송윤재 · e75ca548', '안나']);
  });
});


describe('ThreadPanel — story #4430 a reply\'s send answer puts «not delivered» under my reply', () => {
  it('the send answer\'s `delivery` lands on my new reply', async () => {
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posted.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        return {
          ok: true,
          json: async () => ({
            data: { id: 'reply-9', thread_id: 'parent-1', sender: { id: 'member-1', name: '나', type: 'human' }, content: '회의록 올렸어요.', created_at: '2026-08-08T00:02:00.000Z' },
            delivery: { withheld_count: 1, reason: 'recipient_blocked_sender', conversation_type: 'dm' },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await act(async () => { root.render(wrap(<Harness />)); });
    await flush();
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLElement).click(); });
    await flush();
    expect(container.querySelector('[data-testid="withheld-delivery-line"]')?.textContent)
      .toBe('전달되지 않았어요 — 받는 사람이 내 메시지를 받지 않도록 해 두었어요');
    // story #4440 — the reply send carries a nonce this tab remembers (so its echo does not bump the count again)
    const { isEchoOfSentHere } = await import('@/hooks/use-chat-sse');
    expect(typeof posted[0]?.client_nonce).toBe('string');
    expect(isEchoOfSentHere({ client_nonce: posted[0]!.client_nonce })).toBe(true);
  });
});
