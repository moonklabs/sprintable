// @vitest-environment jsdom
//
// story #3972(E-UX-OVERHAUL·「대화」 구현 2/N) — AC6 첫 화면 ≤3콜(대화목록·메시지·
// 오늘 스냅샷 역조회는 관련 절에서만·열린 산출물은 references 있을 때만) + 렌더
// 통합(스레드 선택→메시지 렌더→역할 태그).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

// story #3990 — story/task 참조가 있는 메시지는 EmbedCard(chat/embed-card.tsx)를
// 그리는데, 그 컴포넌트가 useRouter()를 쓴다(app router 미마운트 테스트 환경 방어).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// story #4008(E-UX-OVERHAUL·v3 셸 실시간) — 실 EventSource/멀티플렉서까지 안 끌고
// 온다(chat-list-view.test.tsx와 동일 관례). 이 파일에선 화면 하위 2곳(스레드 레일=
// chat-v3-screen.tsx 자체, 메시지 열=chat-v3-messages.tsx)이 각자 useChatSse를
// 부르므로, 옵션 모양(onConversationRead 유무)으로 어느 쪽 호출인지 가른다.
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

function meFixture(role: 'owner' | 'admin' | 'member') {
  return { data: { id: 'me-1', project_id: 'proj-1', role } };
}
const ME = meFixture('owner');
const THREADS = {
  data: [
    {
      id: 'conv-1',
      participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'agent-1', name: '담롱 온찬', type: 'agent' }],
      latest_message: { content: '발행 승인을 올려요', created_at: '2026-09-16T06:41:00Z' },
      unread_count: 1,
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

function stub(meOverride: unknown = ME) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/me') return { ok: true, status: 200, json: async () => meOverride };
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
  useChatSseMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(todayV3Enabled = true) {
  const { ChatV3Screen } = await import('./chat-v3-screen');
  await act(async () => { root.render(wrap(<ChatV3Screen todayV3Enabled={todayV3Enabled} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ChatV3Screen — 첫 화면 렌더', () => {
  it('⭐스레드 목록·역할 태그(에이전트)·자동 선택된 스레드의 메시지가 렌더된다', async () => {
    stub();
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-thread-row"]')?.textContent).toContain('담롱 온찬');
    expect(container.textContent).toContain('에이전트');
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('초안을 마쳤어요');
  });

  // 교차 PR 드리프트(유나 점검표 1c6a0ced, 항목 4) — 색 있는 attention만 Badge,
  // 중립 역할 라벨은 muted span으로(4373 task 상태 라벨과 같은 결).
  it('⭐역할 태그(에이전트)는 Badge가 아니라 muted-text span이다', async () => {
    stub();
    await mount();
    const tag = container.querySelector('[data-testid="chat-v3-role-tag-agent"]');
    expect(tag).not.toBeNull();
    expect(tag?.tagName).toBe('SPAN');
    expect(tag?.className).toContain('text-muted-foreground');
  });

  it('⭐안읽음 점 — unread_count>0이면 렌더된다', async () => {
    stub();
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-unread-dot"]')).not.toBeNull();
  });

  it('⭐대화 목록 콜 — owner면 project_id+include_agent_conversations을 싣는다', async () => {
    stub(meFixture('owner'));
    await mount();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/conversations?'));
    expect(call?.[0]).toContain('project_id=proj-1');
    expect(call?.[0]).toContain('include_agent_conversations=true');
  });

  // 페드루 PO CHANGES C1(2026-09-17 00:04Z, PR #4370) — include_agent_conversations은
  // owner/admin 전용(conversations.py:1462-1467) — member가 보내면 BE가 403 거부해
  // 화면 전체가 죽는다. member는 그 파라미터를 아예 안 보내야 한다.
  it('⭐대화 목록 콜 — member면 include_agent_conversations을 안 싣는다(403 회피)', async () => {
    stub(meFixture('member'));
    await mount();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/conversations?'));
    expect(call?.[0]).toContain('project_id=proj-1');
    expect(call?.[0]).not.toContain('include_agent_conversations');
  });

  // 페드루 PO CHANGES C2 — /api/me 실패를 조용히 삼키면 화면이 무한 로딩으로 보인다.
  it('⭐/api/me 실패 — 무한 로딩 대신 오류 상태', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-loading"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('불러오지 못했어요');
  });

  // 교차 PR 드리프트(유나 점검표 1c6a0ced, 항목 4) — 오류 자리에 보이는 「다시
  // 시도」가 실제로 재조회를 트리거하는지.
  it('⭐오류 상태엔 보이는 「다시 시도」 버튼이 있고, 누르면 다시 불러온다', async () => {
    let meShouldFail = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return meShouldFail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ME };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => THREADS };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
    await mount();
    const retryBtn = container.querySelector('[data-testid="chat-v3-retry"]') as HTMLElement;
    expect(retryBtn).not.toBeNull();
    meShouldFail = false;
    await act(async () => { retryBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-v3-thread-row"]')).not.toBeNull();
  });

  // 교차 PR 드리프트 항목 2 — 빈 aria-hidden div 대신 Skeleton이 실제로 보인다.
  it('⭐로딩 中엔 빈 div가 아니라 Skeleton이 뜬다', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // 영원히 pending
    await act(async () => { const { ChatV3Screen } = await import('./chat-v3-screen'); root.render(wrap(<ChatV3Screen todayV3Enabled />)); });
    const loading = container.querySelector('[data-testid="chat-v3-loading"]');
    expect(loading?.children.length).toBeGreaterThan(0);
  });
});

// story #3990(E-UX-OVERHAUL·「대화」 구현 5/N) AC5 — 첫 화면 콜은 이어진 story/task
// 참조가 있을 때만 +2(근거·이력). 참조가 없으면(기존 MESSAGES 픽스처, references:[])
// 그 두 콜 자체가 안 나간다 — 회귀가드.
describe('ChatV3Screen — 콜 예산(story #3990 AC5)', () => {
  it('⭐이어진 story/task 참조가 없으면 근거·이력 콜이 안 나간다(기존 3콜 그대로)', async () => {
    stub();
    await mount();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/evidence'))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/activity-logs'))).toBe(false);
  });

  it('⭐메시지에 story 참조가 있으면 근거·이력 콜이 +2로 나간다(work_item_id/entity_id 그 참조값)', async () => {
    const messagesWithRef = {
      data: [{
        id: 'm1', created_by: 'agent-1', sender_name: '담롱 온찬', sender_type: 'agent', sender_avatar_url: null,
        sender_runtime_type: null, content: '이 스토리 보세요.', attachments: [], created_at: '2026-09-16T06:41:00Z',
        references: [{ target_type: 'story', target_id: 'story-77', form: 'mention' }], approval_target: null,
      }],
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { ok: true, status: 200, json: async () => ME };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => THREADS };
      if (url === '/api/conversations/conv-1/messages') return { ok: true, status: 200, json: async () => messagesWithRef };
      if (url === '/api/today') return { ok: true, status: 200, json: async () => EMPTY_TODAY };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
    await mount();
    const evidenceCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/evidence'));
    const historyCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/activity-logs'));
    expect(evidenceCall?.[0]).toBe('/api/evidence?work_item_id=story-77&work_item_type=story');
    expect(historyCall?.[0]).toBe('/api/activity-logs?entity_type=story&entity_id=story-77');
  });
});

// story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — 화면 플래그 조합
// (CHAT_V3_ENABLED=true·TODAY_V3_ENABLED OFF)에서 「오늘」 링크 3곳(nav·관련·
// 서명)이 그대로 /today면 404. 서버(app/chat/page.tsx)가 이 prop을 내려준다.
describe('ChatV3Screen — TODAY_V3_ENABLED OFF(story #3972 CHANGES)', () => {
  it('⭐ON이면 nav 「오늘」이 /today로 간다', async () => {
    stub();
    await mount(true);
    const navLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘');
    expect(navLink?.getAttribute('href')).toBe('/today');
  });

  it('⭐OFF면 nav 「오늘」이 /org-briefing으로 간다(nav-config.ts zoneNow 정본, 404 방지)', async () => {
    stub();
    await mount(false);
    const navLink = [...container.querySelectorAll('a')].find((a) => a.textContent === '오늘');
    expect(navLink?.getAttribute('href')).toBe('/org-briefing');
  });
});

// story #4008(E-UX-OVERHAUL·v3 셸 실시간) AC3 — 스레드 레일 실시간(미리보기·시각·
// 안읽음 점 갱신·최근 순 재정렬), 지금 열린 스레드는 안읽음 점을 켜지 않는다.
describe('ChatV3Screen — 스레드 레일 실시간(story #4008 AC3)', () => {
  const TWO_THREADS = {
    data: [
      {
        id: 'conv-1',
        participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'agent-1', name: '담롱 온찬', type: 'agent' }],
        latest_message: { content: '발행 승인을 올려요', created_at: '2026-09-16T06:41:00Z' },
        unread_count: 0,
      },
      {
        id: 'conv-2',
        participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'agent-2', name: '카디르', type: 'agent' }],
        latest_message: { content: '이전 대화', created_at: '2026-09-15T06:41:00Z' },
        unread_count: 0,
      },
    ],
  };

  function stubTwoThreads() {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { ok: true, status: 200, json: async () => ME };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => TWO_THREADS };
      if (url === '/api/conversations/conv-1/messages') return { ok: true, status: 200, json: async () => MESSAGES };
      if (url === '/api/today') return { ok: true, status: 200, json: async () => EMPTY_TODAY };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
  }

  // story #4008 CHANGES 2(PO 지적) — chat-v3-messages.tsx는 더 이상 자기 useChatSse가
  // 없다(탭당 SSE 연결이 prod에서 2개로 늘던 문제 처방 — 구독은 이 화면 하나로 통합).
  // 그래서 이 mock은 이제 호출점이 정확히 1곳(이 화면)뿐이다. 재렌더마다 새 호출이
  // 쌓이므로(콜백이 selectedId/me를 closure로 캡처) 최신 것만 써야 한다 — 이전 렌더의
  // stale closure(예: selectedId=null 시점)를 잡으면 오탐(실사고로 발견).
  function railSseOptions() {
    return [...useChatSseMock.mock.calls]
      .reverse()
      .map((c) => c[0] as Record<string, unknown>)
      .find((opts) => 'onConversationRead' in opts) as {
        onConversationMessage?: (payload: Record<string, unknown>) => void;
        onConversationRead?: (payload: { conversation_id: string; unread_count: number }) => void;
        onReconnect?: () => void;
      } | undefined;
  }

  it('⭐다른 스레드(conv-2)에 새 메시지 — 미리보기 갱신+맨 위로 재정렬+안읽음 점 켬', async () => {
    stubTwoThreads();
    await mount();
    // 초기 렌더 — conv-1(최신, 자동선택)이 먼저.
    const rowsBefore = [...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')];
    expect(rowsBefore[0]?.textContent).toContain('담롱 온찬');

    const opts = railSseOptions();
    await act(async () => {
      opts?.onConversationMessage?.({ conversation_id: 'conv-2', content: '새 소식이요', created_at: '2026-09-17T00:00:00Z' });
    });

    const rowsAfter = [...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')];
    expect(rowsAfter[0]?.textContent).toContain('카디르');
    expect(rowsAfter[0]?.textContent).toContain('새 소식이요');
    expect(rowsAfter[0]?.querySelector('[data-testid="chat-v3-unread-dot"]')).not.toBeNull();
  });

  it('⭐지금 열린 스레드(conv-1, 선택됨)에 새 메시지 — 미리보기는 갱신되지만 안읽음 점은 안 켠다', async () => {
    stubTwoThreads();
    await mount();
    const opts = railSseOptions();
    await act(async () => {
      opts?.onConversationMessage?.({ conversation_id: 'conv-1', content: '방금 온 답장', created_at: '2026-09-17T00:01:00Z' });
    });
    const rowsAfter = [...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')];
    expect(rowsAfter[0]?.textContent).toContain('방금 온 답장');
    expect(rowsAfter[0]?.querySelector('[data-testid="chat-v3-unread-dot"]')).toBeNull();
  });

  // story #4008 CHANGES 2 — 대화 열도 이제 이 화면의 단일 구독이 ref로 밀어준다
  // (chat-v3-messages.tsx는 자기 SSE가 없다). 선택된 스레드로 온 메시지가 실제로
  // 그 컬럼에도 반영되는지(단순 rail 갱신뿐 아니라) 여기서 통합 확인.
  it('⭐지금 열린 스레드(conv-1)에 새 메시지 — 대화 열(메시지 컬럼)에도 실시간 반영된다', async () => {
    stubTwoThreads();
    await mount();
    const opts = railSseOptions();
    await act(async () => {
      opts?.onConversationMessage?.({
        conversation_id: 'conv-1', id: 'm-live', sender: { id: 'agent-1', name: '담롱 온찬', type: 'agent' },
        content: '방금 온 답장', created_at: '2026-09-17T00:01:00Z',
      });
    });
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('방금 온 답장');
  });

  // story #4008 CHANGES 2 — 다른 스레드(conv-2) 메시지는 대화 열(conv-1이 선택된 상태)에
  // 안 새어든다(chat-v3-screen.tsx가 selectedId 일치할 때만 ref로 밀어주는 필터).
  it('⭐다른 스레드(conv-2) 메시지는 지금 열린 대화 열(conv-1)에 안 새어든다', async () => {
    stubTwoThreads();
    await mount();
    const opts = railSseOptions();
    await act(async () => {
      opts?.onConversationMessage?.({
        conversation_id: 'conv-2', id: 'm-other', sender: { id: 'agent-2', name: '카디르', type: 'agent' },
        content: '다른 대화로 온 메시지', created_at: '2026-09-17T00:02:00Z',
      });
    });
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).not.toContain('다른 대화로 온 메시지');
  });

  it('⭐conversation.read 이벤트 — 서버 truth로 안읽음 수를 되돌린다', async () => {
    stubTwoThreads();
    await mount();
    const opts = railSseOptions();
    await act(async () => {
      opts?.onConversationMessage?.({ conversation_id: 'conv-2', content: '새 소식이요', created_at: '2026-09-17T00:00:00Z' });
    });
    expect([...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')][0]?.querySelector('[data-testid="chat-v3-unread-dot"]')).not.toBeNull();

    await act(async () => {
      opts?.onConversationRead?.({ conversation_id: 'conv-2', unread_count: 0 });
    });
    expect([...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')][0]?.querySelector('[data-testid="chat-v3-unread-dot"]')).toBeNull();
  });

  it('⭐재연결 — 스레드 목록과 대화 열 둘 다 재조회한다(AC4, 단일 구독이 양쪽에 통지)', async () => {
    stubTwoThreads();
    await mount();
    const listCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/conversations?')).length;
    const messagesCallsBefore = fetchMock.mock.calls.filter((c) => c[0] === '/api/conversations/conv-1/messages').length;
    const opts = railSseOptions();
    await act(async () => { opts?.onReconnect?.(); await Promise.resolve(); await Promise.resolve(); });
    const listCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/conversations?')).length;
    const messagesCallsAfter = fetchMock.mock.calls.filter((c) => c[0] === '/api/conversations/conv-1/messages').length;
    expect(listCallsAfter).toBe(listCallsBefore + 1);
    expect(messagesCallsAfter).toBe(messagesCallsBefore + 1);
  });
});
