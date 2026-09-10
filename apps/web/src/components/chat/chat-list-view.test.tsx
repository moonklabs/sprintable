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
import { ChatRailProvider, useChatRailOptional } from '@/app/(authenticated)/chats/chat-rail-context';

// story #3177(S3a) — ChatListView가 이제 NowStrip을 항상 마운트한다. 이 테스트의 관심사는
// 대화 목록 자체(SSE/아바타/URL 조립)라 NowStrip의 전역 RefreshContext 폴링 배선까지
// 실 provider로 끌고 오지 않는다(useChatSse와 동일 관례 — 교차관심사 훅은 no-op mock).
vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));

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
// story #3621 — connected/polling을 반환하는 실제 훅 shape과 맞춘다(그전엔 이 컴포넌트가
// 반환값을 안 읽어 undefined 반환도 무해했지만, 이제 destructure한다). 기본값은 연결됨 —
// 끊김/폴링 배너 테스트는 useChatSseMock.mockReturnValue로 개별 오버라이드한다.
const { useChatSseMock } = vi.hoisted(() => ({
  useChatSseMock: vi.fn((_opts?: unknown) => ({ connected: true, polling: false })),
}));
vi.mock('@/hooks/use-chat-sse', () => ({
  useChatSse: (opts: unknown) => useChatSseMock(opts),
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

// story #3106(#3092 후속) — DM 상대(oneOnOneParticipant)의 runtime_type이 BE에서 이미
// 내려와도 이 컴포넌트가 Avatar에 안 넘기면 여전히 "Agent" 폴백에 머문다.
describe('ChatListView — story #3106 참가자 runtime_type → Avatar 배선', () => {
  it('DM 상대(agent)의 runtime_type이 있으면 아바타에 커넥터 공식 아이콘이 뜬다', async () => {
    stubFetchWithConversations([{
      id: 'conv-dm-agent-1', type: 'dm', title: null,
      latest_message: null, updated_at: '2026-08-26T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
        { member_id: 'agent-1', name: '올리베이라', avatar_url: null, type: 'agent', runtime_type: 'claude-code' },
      ],
    }]);
    await mount();
    const disk = container.querySelector('.rounded-full.ring-2.ring-background');
    expect(disk?.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/claude-code.jpg');
  });

  it('DM 상대(agent)의 runtime_type이 없으면(레거시) "Agent" 텍스트 폴백 그대로다(회귀 없음)', async () => {
    stubFetchWithConversations([{
      id: 'conv-dm-agent-2', type: 'dm', title: null,
      latest_message: null, updated_at: '2026-08-26T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
        { member_id: 'agent-2', name: '올리베이라', avatar_url: null, type: 'agent' },
      ],
    }]);
    await mount();
    expect(container.querySelector('.rounded-full.ring-2.ring-background')).toBeNull();
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

// story #3203(선생님 실사고·2026-08-29) — 대화 리스트 상대명 자리에 raw uuid가 노출된
// 표시결함 pin. 근본원인은 BE resolver의 orphan 폴백이 uuid 앞 8자를 "이름"처럼 지어내던
// 것(member_resolver.py) — 이제 BE는 name=null을 실어보내고, FE가 그 null을 '?' 1글자가
// 아니라 사람 언어 문구로 폴백해야 한다.
describe('ChatListView — 참가자 이름 해석 실패 폴백(story #3203)', () => {
  it('DM 상대의 name이 null이면(BE orphan 폴백) "알 수 없는 구성원"으로 뜬다 — uuid도 물음표도 아니다', async () => {
    // story #3758(9번째) — resolved=false가 진짜 orphan 신호(word 정 — "멤버"→"구성원").
    stubFetchWithConversations([{
      id: 'conv-dm-orphan-1', type: 'dm', title: null,
      latest_message: null, updated_at: '2026-08-29T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human', resolved: true },
        { member_id: '767988e5-df5b-48e8-9964-7062fe84d691', name: null, avatar_url: null, type: 'human', resolved: false },
      ],
    }]);
    await mount();
    const nameEl = [...container.querySelectorAll('span')].find((el) => el.textContent === '알 수 없는 구성원');
    expect(nameEl).not.toBeUndefined();
    expect(container.textContent).not.toContain('767988e5');
  });

  it('참가자가 실존(resolved=true)인데 name만 null이면 "이름 없는 구성원"으로 뜬다(orphan과 다른 문구)', async () => {
    stubFetchWithConversations([{
      id: 'conv-dm-nameless-1', type: 'dm', title: null,
      latest_message: null, updated_at: '2026-08-29T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human', resolved: true },
        { member_id: 'real-member-1', name: null, avatar_url: null, type: 'human', resolved: true },
      ],
    }]);
    await mount();
    const nameEl = [...container.querySelectorAll('span')].find((el) => el.textContent === '이름 없는 구성원');
    expect(nameEl).not.toBeUndefined();
  });
});

// story #3791(카디르 QA 정정 12:52Z) — oneOnOneParticipant.name이 null이 아니라 빈 문자열
// ""인 경우(`??`는 null/undefined만 잡고 ""는 통과시켜 걸렸던 자리 — codex 재현, 일반/
// 에이전트 탭 둘 다). Avatar의 label이 빈 문자열로 새면 아이콘 tier에서 aria-label=""가
// 되는데, 되돌리면(?.trim() || fallback을 다시 ?? fallback으로) 이 두 테스트가 정확히
// 그 결함을 재현해야 한다.
describe('ChatListView — 참가자 name="" 폴백(story #3791, 카디르 재현)', () => {
  it('일반(DM) 탭 — name=""이면 아바타 aria-label이 "DM"으로 뜬다(빈 문자열 아님)', async () => {
    stubFetchWithConversations([{
      id: 'conv-dm-empty-1', type: 'dm', title: null,
      latest_message: null, updated_at: '2026-08-29T00:00:00Z', unread_count: 0,
      participants: [
        { member_id: 'me-1', name: '나', avatar_url: null, type: 'human', resolved: true },
        { member_id: 'them-empty-1', name: '', avatar_url: null, type: 'human', resolved: true },
      ],
    }]);
    await mount();
    const avatarSpan = container.querySelector('span[aria-label]');
    expect(avatarSpan).not.toBeNull();
    expect(avatarSpan?.getAttribute('aria-label')).toBe('DM');
  });

  it('에이전트 탭 — name=""이면 아바타 aria-label이 "에이전트"로 뜬다(빈 문자열 아님)', async () => {
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
              id: 'conv-agent-dm-empty-1', type: 'dm', title: null,
              latest_message: null, updated_at: '2026-08-23T00:00:00Z', unread_count: 0,
              participants: [
                { member_id: 'me-1', name: '나', avatar_url: null, type: 'human', resolved: true },
                { member_id: 'agent-empty-1', name: '', avatar_url: null, type: 'agent', resolved: true },
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

    const avatarSpan = container.querySelector('span[aria-label]');
    expect(avatarSpan).not.toBeNull();
    expect(avatarSpan?.getAttribute('aria-label')).toBe('에이전트');
  });
});

// story #3621(유나 CHANGES, 2026-09-07) — chat-view.tsx·chat-list-view.tsx 둘 다 같은
// ConnectionLostBanner를 쓴다(단일화, 문구 갈라짐 방지). {connected:false, polling:true}를
// 직접 모킹해 실제로 그 배너가 서는지 확인한다 — 이전엔 두 뷰 테스트가 전부 polling:false만
// 모킹해 어느 쪽도 이 렌더 경로를 실제로 확인한 적이 없었다.
describe('ChatListView — 끊김+폴링 배너(story #3621, useChatSse mock 오버라이드)', () => {
  it('connected=false·polling=true면 "자동 새로고침 중" 배너가 선다', async () => {
    vi.useFakeTimers();
    try {
      useChatSseMock.mockReturnValue({ connected: false, polling: true });
      stubFetchWithConversations([]);
      await act(async () => { root.render(wrap(<ChatListView projectId="proj-current" currentTeamMemberId="me-1" />)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); // showDisconnectedBanner 2s 지연
      const banner = container.querySelector('[data-testid="connection-lost-banner"]');
      expect(banner).not.toBeNull();
      expect(container.querySelector('[data-testid="connection-lost-banner-text"]')?.textContent)
        .toBe(koMessages.chats.connectionLostPolling);
    } finally {
      vi.useRealTimers();
      useChatSseMock.mockReturnValue({ connected: true, polling: false });
    }
  });

  it('connected=false·polling=false(아직 threshold 전)면 "연결이 끊겼어요"만 뜨고, 새로고침 버튼은 여전히 있다', async () => {
    vi.useFakeTimers();
    try {
      useChatSseMock.mockReturnValue({ connected: false, polling: false });
      stubFetchWithConversations([]);
      await act(async () => { root.render(wrap(<ChatListView projectId="proj-current" currentTeamMemberId="me-1" />)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(container.querySelector('[data-testid="connection-lost-banner-text"]')?.textContent)
        .toBe(koMessages.chats.connectionLost);
      const refreshButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.chats.refreshNow));
      expect(refreshButton).not.toBeUndefined(); // 배너(2s)·폴링(10s) 사이에도 조치 수단이 있다.
    } finally {
      vi.useRealTimers();
      useChatSseMock.mockReturnValue({ connected: true, polling: false });
    }
  });

  it('connected=true면 배너 자체가 안 뜬다', async () => {
    vi.useFakeTimers();
    try {
      useChatSseMock.mockReturnValue({ connected: true, polling: false });
      stubFetchWithConversations([]);
      await act(async () => { root.render(wrap(<ChatListView projectId="proj-current" currentTeamMemberId="me-1" />)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(container.querySelector('[data-testid="connection-lost-banner"]')).toBeNull();
    } finally {
      vi.useRealTimers();
      useChatSseMock.mockReturnValue({ connected: true, polling: false });
    }
  });
});

// story #3788(B-③ 후속, 페드루 그라운딩 2026-09-10 10:43Z) — 「내 대화」 0건 + 에이전트 대화
// N건 + 사용자가 「에이전트」 탭을 보고 있을 때, ChatRailContext로 끌어올리는 값은 my 탭이
// 아니라 **지금 보이는(에이전트) 탭**의 것이어야 한다. 이게 안 되면 왼쪽엔 대화가 줄줄이
// 있는데 우측 outlet(chats/page.tsx)이 「대화가 없습니다」를 말하는 모순이 재발한다(카드가
// 원래 잡던 모순이 탭 하나 옆으로 옮겨 앉는 사례).
// DOM으로 읽는다(외부 변수 재할당 대신) — data-* 속성이 곧 단언 대상이라 React 훅
// 불변성 규칙·TS 좁히기 문제 둘 다 안 만난다.
function RailCapture() {
  const rail = useChatRailOptional();
  return (
    <div
      data-testid="rail-capture"
      data-active-list={rail?.activeList ?? ''}
      data-loading={String(rail?.conversationsLoading ?? '')}
      data-count={String(rail?.conversationCount ?? '')}
      data-error={String(rail?.conversationsLoadError ?? '')}
    />
  );
}

function readRailCapture(c: HTMLElement) {
  const el = c.querySelector('[data-testid="rail-capture"]') as HTMLElement | null;
  return {
    activeList: el?.dataset.activeList,
    loading: el?.dataset.loading,
    count: el?.dataset.count,
    error: el?.dataset.error,
  };
}

function stubFetchByTab(myItems: unknown[], agentItems: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (url.includes('/api/conversations?') && url.includes('include_agent_conversations=true')) {
      return { ok: true, json: async () => ({ data: agentItems, total: agentItems.length }) };
    }
    if (url.includes('/api/conversations?')) {
      return { ok: true, json: async () => ({ data: myItems, total: myItems.length }) };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
}

const AGENT_ITEM = {
  id: 'conv-agent-1', type: 'dm', title: '올리베이라와의 대화',
  latest_message: null, updated_at: '2026-09-10T00:00:00Z', unread_count: 0,
  participants: [{ member_id: 'agent-1', name: '올리베이라', avatar_url: null, type: 'agent' }],
};

describe('ChatListView — ChatRailContext 탭 게이트(story #3788 B-③ 후속)', () => {
  it('⭐「내 대화」 0건 + 에이전트 N건 + 에이전트 탭 활성 → conversationCount는 N(0 아님)', async () => {
    useDashboardContextMock.mockReturnValue({ role: 'admin' }); // 탭 자체가 admin/owner 전용(677행)
    stubFetchByTab([], [AGENT_ITEM]);
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-current" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const agentTab = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes('에이전트'));
    expect(agentTab).not.toBeUndefined();
    await act(async () => { agentTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const rail = readRailCapture(container);
    expect(rail.activeList).toBe('agent');
    expect(rail.loading).toBe('false');
    expect(rail.count).toBe('1');
  });

  it('my 탭이 활성일 때는 my 탭 카운트(0)를 민다(에이전트 N건은 안 보이므로 무시)', async () => {
    stubFetchByTab([], [AGENT_ITEM]);
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-current" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const rail = readRailCapture(container);
    expect(rail.activeList).toBe('my');
    expect(rail.count).toBe('0');
  });

  // 카디르 QA(#4139, 772f755e9 재현) — 세션 中 role이 admin/owner→member로 하향되면(리마운트
  // 없이 me.role만 갱신) Tabs는 사라지는데 activeList가 'agent'에 남아 안 보이는 탭의 count를
  // 계속 공급했었다. 뮤테이션 대표: isAdminOrOwner 게이트/리셋 effect 둘 다 지워야 RED.
  it('⭐admin+에이전트 탭 활성 中 role이 member로 하향(리마운트 없음) → count는 my 것(0)·activeList는 my로 리셋', async () => {
    useDashboardContextMock.mockReturnValue({ role: 'admin' });
    stubFetchByTab([], [AGENT_ITEM]);
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-current" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const agentTab = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes('에이전트'));
    await act(async () => { agentTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(readRailCapture(container).activeList).toBe('agent');

    // 리마운트 없이 같은 root에 재렌더 — mock 반환값만 바뀐 채로 다음 렌더가 새 role을 읽는다
    // (실제로는 me.role SSE/폴 갱신이 만드는 상황, 여기선 mock 스왑으로 흉내).
    useDashboardContextMock.mockReturnValue({ role: 'member' });
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-current" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const rail = readRailCapture(container);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(rail.activeList).toBe('my');
    expect(rail.count).toBe('0');
  });
});

// story #3790(유나 定) — 대화 목록 fetch 실패가 「대화가 없습니다」(0건)로 떨어지지 않는다.
// 로딩·실패·0건 세 세계를 좌우가 같은 낱말(chats.conversationsLoadFailed)로 말한다.
function stubFetchWithFailure(which: 'my' | 'agent') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    const isAgentUrl = url.includes('/api/conversations?') && url.includes('include_agent_conversations=true');
    if (url.includes('/api/conversations?')) {
      if ((which === 'my' && !isAgentUrl) || (which === 'agent' && isAgentUrl)) {
        return { ok: false, status: 500, json: async () => null };
      }
      return { ok: true, json: async () => ({ data: [], total: 0 }) };
    }
    return { ok: false, status: 404, json: async () => null };
  }));
}

describe('ChatListView — 목록 fetch 실패 축(story #3790)', () => {
  it('⭐my 탭 fetch 실패 → 레일이 0건(noConversations)이 아니라 실패 문구를 말한다', async () => {
    stubFetchWithFailure('my');
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-current" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).not.toContain(koMessages.chats.noConversations);
    const rail = readRailCapture(container);
    expect(rail.error).toBe('true');
    expect(rail.loading).toBe('false');
  });

  it('agent 탭 fetch 실패(my는 성공) → 에이전트 탭 활성 시 좌우가 모두 실패를 말한다(my N건 무관)', async () => {
    useDashboardContextMock.mockReturnValue({ role: 'admin' });
    stubFetchWithFailure('agent');
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-current" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const agentTab = [...container.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes('에이전트'));
    await act(async () => { agentTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).not.toContain(koMessages.chats.noAgentConversations);
    const rail = readRailCapture(container);
    expect(rail.activeList).toBe('agent');
    expect(rail.error).toBe('true');
  });

  it('재시도 클릭 → 재조회 中 로딩(0건 아님)을 거쳐 성공하면 실패 문구가 사라진다', async () => {
    let attempt = 0;
    // 두 번째(재시도) 응답은 수동으로 붙들어 "아직 응답 전" 창을 결정적으로 관측한다
    // (마이크로태스크가 act() 한 틱 안에서 다 풀려버리면 로딩 창을 못 잡는 레이스 방지).
    let resolveRetry: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url.includes('/api/conversations?') && !url.includes('include_agent_conversations=true')) {
        attempt += 1;
        if (attempt === 1) return { ok: false, status: 500, json: async () => null };
        await new Promise<void>((resolve) => { resolveRetry = resolve; });
        return { ok: true, json: async () => ({ data: [], total: 0 }) };
      }
      return { ok: false, status: 404, json: async () => null };
    }));
    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-current" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.chats.conversationsLoadFailed);

    const retryBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.retry);
    expect(retryBtn).not.toBeUndefined();
    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });

    // 재조회가 resolveRetry에서 멈춰 있는 동안 — 로딩(0건도 실패도 아님).
    expect(resolveRetry).not.toBeUndefined();
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).not.toContain(koMessages.chats.noConversations);

    await act(async () => { resolveRetry!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
    expect(container.textContent).toContain(koMessages.chats.noConversations);
  });
});

describe('ChatListView — 실패 경로 stale-drop(story #3790 후속, 카디르 QA #4142)', () => {
  it('⭐project A pending 中 project B로 전환 → B 성공 렌더 뒤 A의 뒤늦은 실패가 B 화면을 안 덮는다', async () => {
    let resolveAFailure: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url.includes('project_id=proj-a') && url.includes('/api/conversations?') && !url.includes('include_agent_conversations=true')) {
        // A는 응답을 붙들어 뒀다가(아래에서 수동 해소) 실패로 떨어진다.
        await new Promise<void>((resolve) => { resolveAFailure = resolve; });
        return { ok: false, status: 500, json: async () => null };
      }
      if (url.includes('project_id=proj-b') && url.includes('/api/conversations?') && !url.includes('include_agent_conversations=true')) {
        return { ok: true, json: async () => ({ data: [], total: 0 }) };
      }
      return { ok: false, status: 404, json: async () => null };
    }));

    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-a" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // A의 fetch가 아직 resolveAFailure에서 멈춰 있는 채로 — 프로젝트를 B로 전환.
    expect(resolveAFailure).not.toBeUndefined();

    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-b" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // B는 빠르게 성공 — 0건 화면이 정상적으로 섰다.
    expect(container.textContent).toContain(koMessages.chats.noConversations);
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);

    // 이제야 A의 실패가 뒤늦게 도착 — B 화면을 덮으면 안 된다.
    await act(async () => { resolveAFailure!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.chats.conversationsLoadFailed);
    expect(readRailCapture(container).error).toBe('false');
  });
});

describe('ChatListView — my 탭 project 전환 즉시 클리어+로딩(story #3790 후속 2, 페드루 그라운딩 12:34Z)', () => {
  it('⭐project A(0건) → B로 전환 직후(B 응답 前) 우측이 "0건"으로 단정하지 않고 로딩을 말한다', async () => {
    let resolveB: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url.includes('project_id=proj-a') && url.includes('/api/conversations?') && !url.includes('include_agent_conversations=true')) {
        return { ok: true, json: async () => ({ data: [], total: 0 }) };
      }
      if (url.includes('project_id=proj-b') && url.includes('/api/conversations?') && !url.includes('include_agent_conversations=true')) {
        await new Promise<void>((resolve) => { resolveB = resolve; });
        return { ok: true, json: async () => ({ data: [{ id: 'b1', type: 'dm', title: 'B 대화', latest_message: null, updated_at: '2026-09-10T00:00:00Z' }], total: 1 }) };
      }
      return { ok: false, status: 404, json: async () => null };
    }));

    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-a" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(readRailCapture(container).loading).toBe('false');
    expect(readRailCapture(container).count).toBe('0');

    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-b" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    // B의 fetch가 아직 resolveB에서 멈춰 있는 채로 — 우측은 A의 0건을 그대로 우기면 안 된다.
    expect(resolveB).not.toBeUndefined();
    const midSwitch = readRailCapture(container);
    expect(midSwitch.loading).toBe('true');

    await act(async () => { resolveB!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const settled = readRailCapture(container);
    expect(settled.loading).toBe('false');
    expect(settled.count).toBe('1');
  });
});

describe('ChatListView — my 탭 finally의 stale-drop(story #3790 후속 2, 페드루 그라운딩)', () => {
  it('⭐A pending 中 B로 전환(B도 pending) → A가 뒤늦게 성공해도 B의 로딩을 안 끈다', async () => {
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/recent-outside-project')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url.includes('project_id=proj-a') && url.includes('/api/conversations?') && !url.includes('include_agent_conversations=true')) {
        await new Promise<void>((resolve) => { resolveA = resolve; });
        return { ok: true, json: async () => ({ data: [{ id: 'a1', type: 'dm', title: 'A 대화', latest_message: null, updated_at: '2026-09-10T00:00:00Z' }], total: 1 }) };
      }
      if (url.includes('project_id=proj-b') && url.includes('/api/conversations?') && !url.includes('include_agent_conversations=true')) {
        await new Promise<void>((resolve) => { resolveB = resolve; });
        return { ok: true, json: async () => ({ data: [], total: 0 }) };
      }
      return { ok: false, status: 404, json: async () => null };
    }));

    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-a" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(resolveA).not.toBeUndefined();

    await act(async () => {
      root.render(wrap(
        <ChatRailProvider>
          <RailCapture />
          <ChatListView projectId="proj-b" currentTeamMemberId="me-1" />
        </ChatRailProvider>,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(resolveB).not.toBeUndefined();
    expect(readRailCapture(container).loading).toBe('true');

    // A가 뒤늦게 성공 — B는 아직 pending. A의 finally가 loading을 꺼버리면 안 된다.
    await act(async () => { resolveA!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(readRailCapture(container).loading).toBe('true');

    await act(async () => { resolveB!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(readRailCapture(container).loading).toBe('false');
    expect(readRailCapture(container).count).toBe('0');
  });
});
