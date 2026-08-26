// @vitest-environment jsdom
//
// story #2168 PR-② — "다른 프로젝트" 섹션(현재 프로젝트 밖 최근 대화, BE
// GET /conversations/recent-outside-project). AC②(현재 목록 아래 구분 섹션)·③(프로젝트명
// 병기)·④(누르면 `?p=`+`from=`+`pn=`을 실은 URL로 이동 — R2 SSOT가 헤더/스위처 전환을
// 대신 처리하므로 여기선 그 URL을 정확히 만드는지만 고정한다) 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';

const { useDashboardContextMock, pushMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

// use-chat-sse는 EventSource(jsdom 미구현)를 쓰므로 no-op으로 목 — 단, story #1978은 정확히
// onReconnect 배선을 검증해야 하니 마지막 호출의 옵션을 캡처해 테스트에서 직접 불러낸다
// (SSE 백오프/타이머 전체를 재현하지 않는다 — sse-multiplexer.test.tsx가 이미 그 축은
// "실제 재연결 타이밍은 별도"로 선언하고 옵션 배선만 고정하는 동일 관례).
const { useChatSseMock } = vi.hoisted(() => ({ useChatSseMock: vi.fn() }));
vi.mock('@/hooks/use-chat-sse', () => ({
  useChatSse: (opts: unknown) => { useChatSseMock(opts); },
}));

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  useChatSseMock.mockClear();
  useDashboardContextMock.mockReturnValue({ role: 'member' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function stubFetch(outsideProject: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) {
      return { ok: true, json: async () => ({ data: outsideProject }) };
    }
    if (url.includes('/api/conversations?')) {
      return { ok: true, json: async () => ({ data: [], total: 0 }) };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
}

// story #1978 — /api/conversations? 호출 횟수만 센다(목록 백필 재fetch가 실제로 일어났는지).
// /api/conversations/recent-outside-project는 별개 축(마운트 1회 전용, 이 스토리 스코프 밖)이라 안 센다.
function countMyConversationsFetchCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => (url as string).includes('/api/conversations?') && !(url as string).includes('recent-outside-project')).length;
}

async function mount() {
  await act(async () => {
    root.render(wrap(<ChatListView projectId="proj-current" currentTeamMemberId="me-1" />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const OUTSIDE_CONV = {
  id: 'conv-outside-1',
  type: 'dm',
  title: '댄군과의 대화',
  project_id: 'proj-content',
  project_name: 'sprintable-content',
  project_slug: 'sprintable-content',
};

describe('ChatListView — 다른 프로젝트 섹션 (story #2168 PR-②)', () => {
  it('BE가 항목을 주면 "다른 프로젝트" 섹션이 렌더되고 프로젝트명이 병기된다(AC②③)', async () => {
    stubFetch([OUTSIDE_CONV]);
    await mount();
    expect(container.textContent).toContain('다른 프로젝트');
    expect(container.textContent).toContain('댄군과의 대화');
    expect(container.textContent).toContain('sprintable-content');
  });

  it('BE가 빈 배열을 주면 섹션 자체가 조용히 안 보인다(완전분리도 소음도 아닌 세 번째 선택)', async () => {
    stubFetch([]);
    await mount();
    expect(container.textContent).not.toContain('다른 프로젝트');
  });

  it('항목을 누르면 대상 프로젝트(p)·원 프로젝트(from)·표시용 프로젝트명(pn)을 실은 URL로 이동한다(AC④)', async () => {
    stubFetch([OUTSIDE_CONV]);
    await mount();
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('댄군과의 대화'));
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(pushMock).toHaveBeenCalledTimes(1);
    const dest = pushMock.mock.calls[0]?.[0] as string;
    expect(dest.startsWith('/chats/conv-outside-1?')).toBe(true);
    const params = new URLSearchParams(dest.split('?')[1]);
    expect(params.get('p')).toBe('proj-content');
    expect(params.get('from')).toBe('proj-current');
    expect(params.get('pn')).toBe('sprintable-content');
  });

  // 라이브 실측으로 발견(2026-07-27) — 클릭 직후 router.push가 이 컴포넌트 자체를 언마운트시켜,
  // 로컬 useToast()로 띄운 토스트가 화면에 페인트될 새도 없이 사라졌었다. queuePendingToast로
  // sessionStorage에 넘겨 네비게이션을 넘어 살아남게 한다(cross-project-toast-provider.tsx가 소비).
  it('클릭 시 로컬 토스트가 아니라 sessionStorage 경유 queuePendingToast로 메시지를 넘긴다(네비게이션 생존)', async () => {
    stubFetch([OUTSIDE_CONV]);
    sessionStorage.clear();
    await mount();
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('댄군과의 대화'));
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(sessionStorage.getItem('sprintable_pending_toast')).toBe('sprintable-content 프로젝트로 이동');
  });

  // story #2972(선생님 admin 세션 실측) — "다른 프로젝트" DM 행은 title이 항상 NULL(list_
  // conversations 관례)인데 BE가 participants를 안 줘 FE가 상대 이름을 조립할 재료가 없었다.
  // 그 결과 "님과의 대화"(이름 앞이 빈 채 조사만 남은 접미 조각)가 그대로 노출됐다 — BE delta로
  // participants를 실었으니 여기서도 ConversationRow와 동일하게 조립되는지 고정한다.
  it('title=null인 DM 행은 participants로 상대 이름을 조립한다(#2972 fix)', async () => {
    stubFetch([{
      id: 'conv-outside-dm-1', type: 'dm', title: null,
      project_id: 'proj-content', project_name: 'sprintable-content', project_slug: 'sprintable-content',
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
        { member_id: 'them-1', name: '댄', avatar_url: null, type: 'human' },
      ],
    }]);
    await mount();
    expect(container.textContent).toContain('댄');
    expect(container.textContent).not.toContain('님과의 대화');
  });

  // 참가자 정보 자체가 없는 진짜 무재료 상황(구 데이터·participants 필드 부재)만 no-fiction
  // 폴백으로 떨어진다 — "님과의 대화"라는 반쪽 문자열이 아니라 완결된 단어("DM", dmSection과
  // 동일 관례)여야 한다.
  it('participants가 없는 DM 행은 완결된 "DM" 폴백을 쓴다 — 조사만 남는 조립 금지(#2972 AC2)', async () => {
    stubFetch([{
      id: 'conv-outside-dm-2', type: 'dm', title: null,
      project_id: 'proj-content', project_name: 'sprintable-content', project_slug: 'sprintable-content',
    }]);
    await mount();
    expect(container.textContent).not.toContain('님과의 대화');
    const nameEl = [...container.querySelectorAll('span')].find((el) => el.textContent === 'DM');
    expect(nameEl).not.toBeUndefined();
  });
});

// story #2968(선생님 실사용 발견) — 리스트가 avatar.tsx(정본, #2887/#2921)를 안 쓰고 Bot 아이콘/
// 이니셜만 그려 avatar_url이 애초에 죽은 데이터였다(캐시·BE 스냅샷 문제 아님 — 3층 그라운딩
// 실측으로 확認: BE는 write/read 전부 members.avatar_url 라이브, 업로드도 매번 새 uuid4 키).
function stubFetchWithConversations(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (url.includes('/api/conversations?')) {
      return { ok: true, json: async () => ({ data: items, total: items.length }) };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
}

describe('ChatListView — 리스트 아바타 실사진(story #2968)', () => {
  it('DM 상대의 avatar_url이 있으면 이니셜/아이콘 대신 실사진(<img>)을 렌더한다', async () => {
    stubFetchWithConversations([{
      id: 'conv-dm-1', type: 'dm', title: null,
      latest_message: null, updated_at: '2026-08-23T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
        { member_id: 'them-1', name: '유나', avatar_url: 'https://storage.googleapis.com/bucket/avatar/a.png', type: 'human' },
      ],
    }]);
    await mount();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://storage.googleapis.com/bucket/avatar/a.png');
  });

  it('avatar_url이 없으면(레거시·미업로드) Avatar 정본 자체의 이니셜 폴백으로 떨어진다(img 없음)', async () => {
    stubFetchWithConversations([{
      id: 'conv-dm-2', type: 'dm', title: null,
      latest_message: null, updated_at: '2026-08-23T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
        { member_id: 'them-2', name: '유나', avatar_url: null, type: 'human' },
      ],
    }]);
    await mount();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('유나');
  });

  // 음성대조 — group은 특정 1인 사진이 의미 없어(다인원) 기존 Users 아이콘 자리를 그대로 유지한다.
  it('group 대화는 여전히 단일 실사진을 그리지 않는다(다인원, 회귀 0)', async () => {
    stubFetchWithConversations([{
      id: 'conv-group-1', type: 'group', title: '팀 채널',
      latest_message: null, updated_at: '2026-08-23T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
        { member_id: 'them-1', name: '유나', avatar_url: 'https://storage.googleapis.com/bucket/avatar/a.png', type: 'human' },
        { member_id: 'them-2', name: '카디르', avatar_url: 'https://storage.googleapis.com/bucket/avatar/b.png', type: 'human' },
      ],
    }]);
    await mount();
    expect(container.querySelector('img')).toBeNull();
  });

  // 카디르 QA(#3397, HIGH 재발) — agentOnlyConvs 필터(`!myConvIds.has(c.id)`)는 conv.type을
  // 안 가려 group 대화도 isAgentConv=true로 렌더된다. 그 경로에서까지 "임의 참가자 1인 사진을
  // 대표사진처럼" 보여주면 안 된다(PR 자신의 group 원칙 위반) — 기존 group 테스트는 일반탭만
  // 커버해 이 회귀를 놓쳤다. agent 탭을 실제로 열어(role="tab" 클릭) 검증한다.
  it('agent 탭의 group 대화도 임의 참가자 사진을 대표사진처럼 노출하지 않는다(회귀 재발 방지)', async () => {
    useDashboardContextMock.mockReturnValue({ role: 'admin' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url.includes('include_agent_conversations=true')) {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: 'conv-agent-group-1', type: 'group', title: '에이전트 그룹',
              latest_message: null, updated_at: '2026-08-23T00:00:00Z', unread_count: 0,
              participants: [
                { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
                { member_id: 'agent-1', name: '올리베이라', avatar_url: 'https://storage.googleapis.com/bucket/avatar/agent.png', type: 'agent' },
                { member_id: 'human-1', name: '유나', avatar_url: 'https://storage.googleapis.com/bucket/avatar/yuna.png', type: 'human' },
              ],
            }],
            total: 1,
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [], total: 0 }) };
    }));
    await mount();

    const agentTab = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes('에이전트'));
    expect(agentTab).not.toBeUndefined();
    await act(async () => { agentTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('에이전트 그룹');
    expect(container.querySelector('img')).toBeNull();
  });
});

// story #1978(트랙C) — SSE 드롭 후 놓친 conversation.message_created가 목록에 미백필되던
// 두 구멍(재연결·백그라운드 복귀)을 고정한다. useChatSse는 위에서 옵션 캡처용으로만 목했으므로
// 실제 SSE 백오프/타이머는 재현하지 않는다 — onReconnect 콜백이 넘어왔는지, 그리고 그 콜백을
// 직접 불렀을 때 실제로 재fetch가 도는지만 검증한다(배선 고정).
describe('ChatListView — SSE 재연결·백그라운드 복귀 재fetch (story #1978)', () => {
  it('useChatSse에 onReconnect가 넘어가고, 그걸 부르면 목록이 재fetch된다(AC①)', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    const opts = useChatSseMock.mock.calls.at(-1)?.[0] as { onReconnect?: () => void } | undefined;
    expect(typeof opts?.onReconnect).toBe('function');
    await act(async () => { opts!.onReconnect!(); });
    await act(async () => { await Promise.resolve(); });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount + 1);
  });

  it('탭이 백그라운드에서 복귀(visibilitychange, hidden=false)하면 목록이 재fetch된다(AC①)', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await Promise.resolve(); });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount + 1);
  });

  it('탭이 백그라운드로 갈 때(hidden=true)는 재fetch하지 않는다(불필요 호출 억제, AC③)', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await Promise.resolve(); });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount);
  });
});

describe('ChatListView — window.focus 강제 재fetch·중복 coalescing (story #3081)', () => {
  it('window.focus가 오면(visibilitychange 없이도) 목록이 재fetch된다', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { await Promise.resolve(); });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount + 1);
  });

  it('SSE onReconnect와 focus가 근접 시점에 겹치면 재fetch가 1회로 coalesce된다', async () => {
    stubFetch([]);
    await mount();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCount = countMyConversationsFetchCalls(fetchMock);

    const opts = useChatSseMock.mock.calls.at(-1)?.[0] as { onReconnect?: () => void } | undefined;
    await act(async () => {
      opts!.onReconnect!();
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => { await Promise.resolve(); });

    expect(countMyConversationsFetchCalls(fetchMock)).toBe(beforeCount + 1); // 2가 아니라 1
  });
});

// story #2969 §1.3-b(doc proofline-system-layer-2969, PR-5) — 대화명=Claim(600)로 재분류
// (구조·크기 불변, preview는 이미 Body-small 부합이라 무편집).
describe('ChatListView — 대화명 Claim 무게(story #2969 PR-5)', () => {
  it('대화명이 font-semibold(Claim 무게)를 갖는다', async () => {
    stubFetchWithConversations([{
      id: 'conv-dm-1', type: 'dm', title: '유나',
      latest_message: null, updated_at: '2026-08-23T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
        { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' },
      ],
    }]);
    await mount();
    const nameEl = [...container.querySelectorAll('span')].find((el) => el.textContent === '유나');
    expect(nameEl).not.toBeUndefined();
    expect(nameEl?.className).toContain('font-semibold');
    expect(nameEl?.className).not.toContain('font-medium');
  });

  // 카디르 QA독립검증(PR#3405) — PR-5가 ConversationRow만 커버해 OutsideProjectRow의 동일
  // 처방(§1.3-b)이 무테스트였던 갭. PR-6(#3405 이월분)에 편입.
  it('"다른 프로젝트" 항목의 대화명도 font-semibold(Claim 무게)를 갖는다', async () => {
    stubFetch([OUTSIDE_CONV]);
    await mount();
    const nameEl = [...container.querySelectorAll('span')].find((el) => el.textContent === '댄군과의 대화');
    expect(nameEl).not.toBeUndefined();
    expect(nameEl?.className).toContain('font-semibold');
    expect(nameEl?.className).not.toContain('font-medium');
  });
});
