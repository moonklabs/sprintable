// @vitest-environment jsdom
//
// story #2168 PR-② 회귀가드 — 2축:
// ① AC④ "뒤로가기로 원 프로젝트 복귀" — "다른 프로젝트" 경유(`?from=`)로 온 뒤로가기 버튼이
//    `/chats?p={from}`으로 복귀하는가(새 되돌리기 UI 없이 기존 버튼이 겸함).
// ② 실패 자리 — 단건 조회가 403이면 조용히 비지 않고 중립 톤 안내(제목/본문/다음 발)를
//    렌더하는가(⛔destructive 색상 미사용 — EmptyState는 muted 배경 고정이라 구조로 보장).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, replaceMock, searchParamsRef } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsRef: { current: '' as string },
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParamsRef.current),
}));

// ChatView 자체는 SSE(EventSource, jsdom 미구현)를 물어 이 테스트 스코프 밖 — 얇은 스텁으로 대체.
vi.mock('@/components/chat/chat-view', () => ({
  ChatView: () => <div data-testid="chat-view-stub" />,
}));

vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({
  useSyntheticParentTabHistory: () => {},
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
  replaceMock.mockClear();
  searchParamsRef.current = '';
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-content' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  // TopBarSlot은 title/actions를 context state에 등록만 하고 null을 렌더한다(top-bar-slot.tsx) —
  // 실제 DOM은 앱의 진짜 TopBar 컴포넌트가 그 state를 읽어 그린다. 이 테스트는 그 소비자를
  // 최소 재현해 뒤로가기 버튼(title 안에 있음)이 실제로 DOM에 나타나게 한다.
  function TopBarRenderer() {
    const { title, actions } = useTopBar();
    return <div>{title}{actions}</div>;
  }
  await act(async () => {
    root.render(wrap(
      <TopBarProvider>
        <TopBarRenderer />
        <ConversationPage />
      </TopBarProvider>,
    ));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ConversationPage — 뒤로가기 복귀 (story #2168 PR-② AC④)', () => {
  const FROM_PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
  const TO_PROJECT_UUID = '22222222-2222-4222-8222-222222222222';

  it('?from=이 있으면 뒤로가기가 /chats?p={from}으로 복귀한다(원 프로젝트로)', async () => {
    searchParamsRef.current = `p=${TO_PROJECT_UUID}&from=${FROM_PROJECT_UUID}&pn=sprintable-content`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) {
        return { ok: true, json: async () => ({ title: '댄군과의 대화', type: 'dm', participants: [] }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();

    const backBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('채팅'));
    await act(async () => { backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(replaceMock).toHaveBeenCalledWith(`/chats?p=${FROM_PROJECT_UUID}`);
  });

  it('?from=이 project id(UUID) 형식이 아니면 신뢰하지 않고 /chats로 떨어진다(형식 검증)', async () => {
    searchParamsRef.current = 'from=not-a-uuid;alert(1)';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: null, type: 'dm', participants: [] }) })));
    await mount();

    const backBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('채팅'));
    await act(async () => { backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(replaceMock).toHaveBeenCalledWith('/chats');
  });

  it('?from=이 없으면(직접 진입 등) 기존대로 /chats로 복귀한다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: null, type: 'dm', participants: [] }) })));
    await mount();

    const backBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('채팅'));
    await act(async () => { backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(replaceMock).toHaveBeenCalledWith('/chats');
  });
});

describe('ConversationPage — 실패 자리 (story #2168 PR-②, 능동 클릭 후 403)', () => {
  it('단건 조회가 403이면 중립 톤 안내(제목·프로젝트명 포함 본문·다음 발)를 렌더하고 ChatView는 안 그린다', async () => {
    searchParamsRef.current = 'p=proj-content&from=proj-current&pn=sprintable-content';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN' } }) })));
    await mount();

    expect(container.querySelector('[data-testid="chat-view-stub"]')).toBeNull();
    expect(container.textContent).toContain('이 대화를 열 수 없습니다');
    expect(container.textContent).toContain('sprintable-content');
    expect(container.textContent).toContain('관리자에게 요청하세요');
  });

  it('?pn=이 없으면(직접 URL 진입 등) 프로젝트명 폴백 문구로 graceful 하게 떨어진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => null })));
    await mount();

    expect(container.textContent).toContain('해당 프로젝트에 접근 권한이 없습니다');
  });
});

// story #2968(선생님 실사용 발견) — 채팅 헤더는 이전까지 avatar_url을 애초에 안 그렸다(제목
// 텍스트만). avatar.tsx 정본(#2887/#2921) 배선으로 DM 상대의 실사진을 헤더에도 노출한다.
describe('ConversationPage — 헤더 아바타(story #2968)', () => {
  it('DM 상대의 avatar_url이 있으면 헤더에 실사진(<img>)을 렌더한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) {
        return {
          ok: true,
          json: async () => ({
            title: null, type: 'dm', muted: false, lastReadAt: null, freeResponse: false,
            participants: [
              { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
              { member_id: 'them-1', name: '유나', avatar_url: 'https://storage.googleapis.com/bucket/avatar/a.png', type: 'human' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://storage.googleapis.com/bucket/avatar/a.png');
  });

  it('group 대화는 헤더에 단일 실사진을 그리지 않는다(다인원, 회귀 0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) {
        return {
          ok: true,
          json: async () => ({
            title: '팀 채널', type: 'group', muted: false, lastReadAt: null, freeResponse: false,
            participants: [
              { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
              { member_id: 'them-1', name: '유나', avatar_url: 'https://storage.googleapis.com/bucket/avatar/a.png', type: 'human' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();

    expect(container.querySelector('img')).toBeNull();
  });
});

// story #2969 §1.3-b(doc proofline-system-layer-2969, PR-5) — 헤더 상대명/방이름=Claim(600)
// 로 재분류(구조·크기 불변).
describe('ConversationPage — 헤더 타이틀 Claim 무게(story #2969 PR-5)', () => {
  it('DM 헤더 타이틀이 font-semibold(Claim 무게)를 갖는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) {
        return {
          ok: true,
          json: async () => ({
            title: null, type: 'dm', muted: false, lastReadAt: null, freeResponse: false,
            participants: [
              { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
              { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();

    const titleEl = [...container.querySelectorAll('span')].find((el) => el.textContent === '유나');
    expect(titleEl).not.toBeUndefined();
    expect(titleEl?.className).toContain('font-semibold');
    expect(titleEl?.className).not.toContain('font-medium');
  });
});
