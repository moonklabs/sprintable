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
// 결함④(3998 PO 지적) — 실 백엔드 응답은 sender_name/created_by 평탄 필드가 아니라
// 중첩 `sender:{id,name,type,avatar_url,runtime_type}`(conversations.py::_msg_payload).
// 평탄 필드로 목을 만들면 normalizeToMessage 없이도 테스트가 green이 나 결함④를 놓친다.
const MESSAGES = {
  data: [
    {
      id: 'm1', conversation_id: 'conv-1', thread_id: null,
      sender: { id: 'agent-1', name: '담롱 온찬', type: 'agent', avatar_url: null, runtime_type: null },
      content: '초안을 마쳤어요.', attachments: [], created_at: '2026-09-16T06:41:00Z',
      references: [], approval_target: null,
    },
    // 페드루 PO 추가 지적(2026-09-17 10:09Z, PR 4370 코멘트) — isMine(:115 m.created_by
    // === meId)은 결함④의 나머지 반쪽. sender.id===meId 메시지가 없으면 이 축이 안 깨진다.
    {
      id: 'm2', conversation_id: 'conv-1', thread_id: null,
      sender: { id: 'me-1', name: '나', type: 'human', avatar_url: null, runtime_type: null },
      content: '고마워요, 확認해볼게요.', attachments: [], created_at: '2026-09-16T06:42:00Z',
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
    const messagesColumn = container.querySelector('[data-testid="chat-v3-messages-column"]');
    expect(messagesColumn?.textContent).toContain('초안을 마쳤어요');
    // 결함④(3998 PO 지적, 4370 CHANGES) — 말풍선에 보낸 사람 이름이 실제로 렌더돼야 한다
    // (중첩 sender 응답을 normalizeToMessage 없이 캐스트만 하면 이 라벨이 빈칸으로 샌다).
    expect(messagesColumn?.textContent).toContain('담롱 온찬');
    // 결함④ 나머지 반쪽(페드루 PO 2026-09-17 10:09Z) — isMine(created_by===meId)도 정규화
    // 없인 항상 false로 샌다. 「나」 라벨 + 오른쪽 정렬(ml-auto) 둘 다 확認.
    const labels = [...(messagesColumn?.querySelectorAll('p.text-xs.text-muted-foreground') ?? [])];
    const myLabel = labels.find((p) => p.textContent === '나');
    expect(myLabel).toBeDefined();
    expect(myLabel?.parentElement?.className).toContain('ml-auto');
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
