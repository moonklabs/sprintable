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
// story #4018 — usePathname/useSearchParams 추가(주소 쿼리 `conversation` 딥링크).
// searchParamsRef.current를 테스트마다 갈아 끼워 URL 인자를 시뮬레이션한다.
const { pushMock, replaceMock, searchParamsRef } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => '/chat',
  useSearchParams: () => searchParamsRef.current,
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
  pushMock.mockClear();
  replaceMock.mockClear();
  searchParamsRef.current = new URLSearchParams();
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

// story #4018(E-UX-OVERHAUL·v3 대화·특정 대화 주소) AC1/AC2/AC3/AC4 — PO 확定
// (2026-09-17): 쿼리 `?conversation=<id>`. 인자 있으면 그 대화·없으면 첫 대화가 기본
// (replace, 뒤로가기 기록 0) · 사람이 고르면 push(뒤로가기=이전 대화) · 없는/권한
// 없는 id는 목록은 그대로 두고 스레드 열에 중립 안내(유나 시안 703ed02d §4018).
describe('ChatV3Screen — 특정 대화 주소(story #4018)', () => {
  const TWO_THREADS_4018 = {
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
  const CONV2_MESSAGES = {
    data: [
      {
        id: 'm2', created_by: 'agent-2', sender_name: '카디르', sender_type: 'agent', sender_avatar_url: null,
        sender_runtime_type: null, content: '리뷰 남겼어요.', attachments: [], created_at: '2026-09-15T06:41:00Z',
        references: [], approval_target: null,
      },
    ],
  };

  function stub4018() {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { ok: true, status: 200, json: async () => ME };
      if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => TWO_THREADS_4018 };
      if (url === '/api/conversations/conv-1/messages') return { ok: true, status: 200, json: async () => MESSAGES };
      if (url === '/api/conversations/conv-2/messages') return { ok: true, status: 200, json: async () => CONV2_MESSAGES };
      if (url === '/api/today') return { ok: true, status: 200, json: async () => EMPTY_TODAY };
      // story #4018 CHANGES 1 — 30건 목록에 없는 id는 단건 조회로 한 번 더 확인한다.
      // 이 테스트 파일의 존재하지 않는/권한없는 id는 실 BE의 404/403(conversations.py:1794)
      // 를 그대로 재현 — 둘 다 같은 신호(AC2)로 소비돼야 한다.
      if (url === '/api/conversations/conv-does-not-exist') return { ok: false, status: 404, json: async () => ({}) };
      if (url === '/api/conversations/conv-other-org-no-access') return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: null }) };
    });
  }

  it('⭐AC1 — 인자 있음(유효한 id): 그 대화가 선택·표시된다(첫 대화 아님)', async () => {
    stub4018();
    searchParamsRef.current = new URLSearchParams('conversation=conv-2');
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('리뷰 남겼어요');
    expect(container.querySelector('[aria-current="true"]')?.textContent).toContain('카디르');
  });

  it('⭐AC1/AC3 — 인자 없음: 첫 대화가 기본 선택되고, 주소는 replace로 반영된다(push 아님)', async () => {
    stub4018();
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('초안을 마쳤어요');
    expect(replaceMock).toHaveBeenCalledWith('/chat?conversation=conv-1');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('⭐AC2 — 없는 대화 id: 목록은 그대로, 스레드 열엔 중립 안내(존재 여부 안 밝힘)', async () => {
    stub4018();
    searchParamsRef.current = new URLSearchParams('conversation=conv-does-not-exist');
    await mount();
    const rows = [...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')];
    expect(rows.length).toBe(2); // 레일 무변 — 목록은 그대로 둘 다 보임.
    expect(container.querySelector('[data-testid="chat-v3-conversation-unavailable"]')?.textContent).toContain('이 대화를 열 수 없어요');
    expect(container.querySelector('[data-testid="chat-v3-conversation-unavailable"]')?.textContent).toContain('없는 대화이거나 볼 권한이 없어요');
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')).toBeNull();
  });

  // AC2 — 권한 없는 대화 id도 클라이언트 관점에선 「없는 id」와 같은 신호다: BE가 이미
  // /api/conversations를 호출자 접근 범위로 스코프해 응답하므로, 남의(비참가) 대화
  // id는 이 목록에 애초에 없다 — 존재/미존재/권한없음을 안 가르는 게 바로 AC2의
  // 프라이버시 요구(문구도 한 문장으로 통일)라 클라 코드도 판정을 안 가른다(같은
  // 분기, 위 테스트와 동일 경로 재사용).
  it('⭐AC2 — 권한 없는 대화 id도 같은 중립 안내(메시지 조회 0)', async () => {
    stub4018();
    // BE가 스코프한 응답엔 애초에 안 실리므로, 목록에 없는 id는 "없음"이든 "권한없음"
    // 이든 클라에서 구별 불가능·구별할 필요도 없다(AC2 프라이버시 요구) — 같은 id로 재현.
    searchParamsRef.current = new URLSearchParams('conversation=conv-other-org-no-access');
    await mount();
    expect(container.querySelector('[data-testid="chat-v3-conversation-unavailable"]')).not.toBeNull();
    expect([...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')].length).toBe(2);
    // 페드루 PO CHANGES 1 — 권한 없는 대화는 메시지 열이 아예 안 뜨니 그 프록시도
    // 안 불려야 한다(불필요한 조회·잠재 노출면 최소화).
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/conversations/conv-other-org-no-access/messages')).toBe(false);
  });

  // 페드루 PO CHANGES 1(2026-09-17) — 목록 콜(`GET /api/conversations`)엔 limit이 없어
  // BE 기본 30건만 온다. 그 밖(예: 31번째, 알림 등으로 온 오래된 대화)의 유효한 id는
  // 목록엔 없어도 실제로는 열려야 한다 — 단건 조회(`GET /api/conversations/{id}`)로 폴백.
  describe('CHANGES 1 — 30건 목록 밖 id(단건 조회 폴백)', () => {
    const OUTSIDE_PAGE_ID = 'conv-31st-outside-page';
    const OUTSIDE_PAGE_CONVERSATION = {
      id: OUTSIDE_PAGE_ID,
      participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'agent-3', name: '유나', type: 'agent' }],
      unread_count: 0,
    };
    const OUTSIDE_PAGE_MESSAGES = {
      data: [
        {
          id: 'm31', created_by: 'agent-3', sender_name: '유나', sender_type: 'agent', sender_avatar_url: null,
          sender_runtime_type: null, content: '31번째 대화 메시지예요.', attachments: [], created_at: '2026-09-01T00:00:00Z',
          references: [], approval_target: null,
        },
      ],
    };

    function stubOutsidePage(directResponse: { ok: boolean; status: number }) {
      fetchMock.mockImplementation(async (url: string) => {
        if (url === '/api/me') return { ok: true, status: 200, json: async () => ME };
        if (url.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => TWO_THREADS_4018 };
        if (url === '/api/conversations/conv-1/messages') return { ok: true, status: 200, json: async () => MESSAGES };
        if (url === '/api/today') return { ok: true, status: 200, json: async () => EMPTY_TODAY };
        if (url === `/api/conversations/${OUTSIDE_PAGE_ID}`) {
          return { ...directResponse, json: async () => (directResponse.ok ? OUTSIDE_PAGE_CONVERSATION : {}) };
        }
        if (url === `/api/conversations/${OUTSIDE_PAGE_ID}/messages`) return { ok: true, status: 200, json: async () => OUTSIDE_PAGE_MESSAGES };
        return { ok: true, status: 200, json: async () => ({ data: null }) };
      });
    }

    it('⭐31번째 id(목록 밖, 유효) — 단건 조회로 정상 열린다', async () => {
      stubOutsidePage({ ok: true, status: 200 });
      searchParamsRef.current = new URLSearchParams(`conversation=${OUTSIDE_PAGE_ID}`);
      await mount();
      expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('31번째 대화 메시지예요');
      // 레일은 30건 목록 그대로(이 대화는 그 목록에 없으니 레일엔 하이라이트 자체가 없다 — 회귀 아님, 목록 무변이 계약).
      expect([...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')].length).toBe(2);
    });

    it('⭐404(단건 조회) — 「열 수 없어요」 중립 안내', async () => {
      stubOutsidePage({ ok: false, status: 404 });
      searchParamsRef.current = new URLSearchParams(`conversation=${OUTSIDE_PAGE_ID}`);
      await mount();
      expect(container.querySelector('[data-testid="chat-v3-conversation-unavailable"]')).not.toBeNull();
    });

    it('⭐403(단건 조회) — 「열 수 없어요」 중립 안내 + 메시지 조회 0', async () => {
      stubOutsidePage({ ok: false, status: 403 });
      searchParamsRef.current = new URLSearchParams(`conversation=${OUTSIDE_PAGE_ID}`);
      await mount();
      expect(container.querySelector('[data-testid="chat-v3-conversation-unavailable"]')).not.toBeNull();
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === `/api/conversations/${OUTSIDE_PAGE_ID}/messages`)).toBe(false);
    });

    it('⭐500(단건 조회) — 「없는 대화」로 단정하지 않고 로드 오류+재시도', async () => {
      stubOutsidePage({ ok: false, status: 500 });
      searchParamsRef.current = new URLSearchParams(`conversation=${OUTSIDE_PAGE_ID}`);
      await mount();
      expect(container.querySelector('[data-testid="chat-v3-conversation-unavailable"]')).toBeNull();
      expect(container.querySelector('[data-testid="chat-v3-conversation-retry"]')).not.toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('불러오지 못했어요');
    });
  });

  it('⭐AC3 — 사람이 다른 대화를 고르면 주소가 push로 갱신된다(뒤로가기=이전 대화)', async () => {
    stub4018();
    await mount();
    pushMock.mockClear(); // 마운트 중 replace(기본 선택)는 이 단언 대상이 아님.
    const rows = [...container.querySelectorAll('[data-testid="chat-v3-thread-row"]')];
    const conv2Row = rows.find((r) => r.textContent?.includes('카디르')) as HTMLElement;
    await act(async () => { conv2Row.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(pushMock).toHaveBeenCalledWith('/chat?conversation=conv-2');
    expect(container.querySelector('[data-testid="chat-v3-messages-column"]')?.textContent).toContain('리뷰 남겼어요');
  });

  // AC4 양성 대조 — 주소 인자를 실제로 읽는지 스스로 검증(뮤테이션 self-check, 수동
  // 재현 완료): chat-v3-screen.tsx의 `conversationParam` 읽기 분기를 임시로 주석
  // 처리하고 이 두 테스트(위 "인자 있음" 1개 + AC2 "없는 id" 1개)를 재실행 →
  // conv-2 선택 실패("리뷰 남겼어요" 못 찾음)·미존재 id도 조용히 conv-1이 뜨는 걸로
  // RED 확인 → 원복 → GREEN 재확인. (되돌린 뒤 상태만 커밋 — 임시 주석은 남기지 않음.)
});
