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

// story 4887 — the page asks «is this a phone (below lg)?»; each test says so (default: a desktop)
const belowLg = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => belowLg.current, useIsBelowLg: () => belowLg.current }));

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
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-content', projectMemberships: [] });
});

afterEach(async () => {
  belowLg.current = false;
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

    belowLg.current = true; // the back arrow lives in the shell's header row on a phone (RoomBarTitle)
    await mount();
    const backBtn = container.querySelector('[data-testid="room-bar-back"]'); // an icon button named «대화»
    await act(async () => { backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(replaceMock).toHaveBeenCalledWith(`/chats?p=${FROM_PROJECT_UUID}`);
  });

  it('?from=이 project id(UUID) 형식이 아니면 신뢰하지 않고 /chats로 떨어진다(형식 검증)', async () => {
    searchParamsRef.current = 'from=not-a-uuid;alert(1)';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: null, type: 'dm', participants: [] }) })));

    belowLg.current = true; // the back arrow lives in the shell's header row on a phone (RoomBarTitle)
    await mount();
    const backBtn = container.querySelector('[data-testid="room-bar-back"]'); // an icon button named «대화»
    await act(async () => { backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // story #4231 — 현재 프로젝트(`?p=`)를 싣고 복귀(착지한 flat 목록이 셸 ?p= 정규화로 다시 요청하지 않게).
    expect(replaceMock).toHaveBeenCalledWith('/chats?p=proj-content');
  });

  it('?from=이 없으면(직접 진입 등) 기존대로 /chats로 복귀한다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: null, type: 'dm', participants: [] }) })));

    belowLg.current = true; // the back arrow lives in the shell's header row on a phone (RoomBarTitle)
    await mount();
    const backBtn = container.querySelector('[data-testid="room-bar-back"]'); // an icon button named «대화»
    await act(async () => { backBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // story #4231 — 현재 프로젝트(`?p=`)를 싣고 복귀(착지한 flat 목록이 셸 ?p= 정규화로 다시 요청하지 않게).
    expect(replaceMock).toHaveBeenCalledWith('/chats?p=proj-content');
  });
});

describe('ConversationPage — 실패 자리 (story #2168 PR-②, 능동 클릭 후 403)', () => {
  it('단건 조회가 403이면 중립 톤 안내(제목·프로젝트명 포함 본문·다음 발)를 렌더하고 ChatView는 안 그린다', async () => {
    searchParamsRef.current = 'p=proj-content&from=proj-current&pn=sprintable-content';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN' } }) })));
    await mount();

    expect(container.querySelector('[data-testid="chat-view-stub"]')).toBeNull();
    expect(container.textContent).toContain('이 대화를 열 수 없어요');
    expect(container.textContent).toContain('sprintable-content');
    expect(container.textContent).toContain('관리자에게 요청하세요');
  });

  it('?pn=이 없으면(직접 URL 진입 등) 프로젝트명 폴백 문구로 graceful 하게 떨어진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => null })));
    await mount();

    expect(container.textContent).toContain('해당 프로젝트에 접근 권한이 없어요');
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

    // story 4887 (UI-4 screen PR) — the head shows each participant as a chip with its own avatar: the other person's real photo is in their chip
    const img = container.querySelector('[data-testid="room-head-chips"] img');
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

    // story 4887 (UI-4 screen PR) — no single representative photo in the title (a group has many); each participant has their own chip below it
    expect(container.querySelector('[data-testid="room-head"] h1 img')).toBeNull();
    expect(container.querySelectorAll('[data-testid="room-head-chip"]')).toHaveLength(2);
  });

  // story 4887 (UI-4 screen PR · the approved room head) — the old test here pinned the shell top bar's clipping of an agent avatar's ring (#2988); the head is its own block now and the
  // clipping is gone. What the head owes instead: one chip per participant, an AGENT's chip saying how it is connected, and no button of its own besides «⋯» and the chip row's «+».
  it('⭐ the head: name (h1) · tag · one line of facts · a chip per participant — an agent\'s chip carries its connection word', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) {
        return {
          ok: true,
          json: async () => ({
            title: null, type: 'dm', muted: false, lastReadAt: null, freeResponse: false,
            participants: [
              { member_id: 'me-1', name: '나', avatar_url: null, type: 'human' },
              { member_id: 'them-1', name: '페드루', avatar_url: null, type: 'agent' },
            ],
          }),
        };
      }
      if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [{ id: 'them-1', presence_status: 'online' }] }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const head = container.querySelector('[data-testid="room-head"]') as HTMLElement;
    expect(head, 'the room head').not.toBeNull();
    expect(head.querySelector('h1')?.textContent).toBe('페드루');
    expect(head.querySelector('[data-testid="room-head-tag"]')?.textContent).toBe('DM');
    expect(head.querySelector('[data-testid="room-head-subline"]')?.textContent).toContain('2명');
    const chips = [...head.querySelectorAll('[data-testid="room-head-chip"]')];
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('나(나)'.replace('나(나)', '(나)')); // «name(나)» for the person themself
    expect(chips[1]!.textContent).toContain('페드루');
    expect(chips[1]!.querySelector('[data-status="online"]')?.textContent, 'the agent\'s connection word').toBe(koMessages.chats.presenceOnline);
    expect(chips[0]!.querySelector('[data-slot="ds-status-label"]'), 'a person has no connection word (no presence exists for people)').toBeNull();
  });

  it('⭐ while the room\'s data is not there (the lookup fails) the head draws no «+» — a button that does nothing is not drawn', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await mount();
    expect(container.querySelector('[data-testid="room-head-add"]')).toBeNull(); // reverted (always drawn) → a dead «+»
  });

  const groupRoom = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/conv-1')) {
      return { ok: true, json: async () => ({ title: '팀 채널', type: 'group', muted: false, lastReadAt: null, freeResponse: false, participants: [{ member_id: 'me-1', name: '나', avatar_url: null, type: 'human' }, { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' }] }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));

  it('a DESKTOP (lg up): the in-column head has no button of its own — the «+» of the chip row, the «⋯» menu and the group name\'s edit; no back arrow, and the phone bar is not drawn', async () => {
    groupRoom();
    await mount();
    const head = container.querySelector('[data-testid="room-head"]') as HTMLElement;
    const names = [...head.querySelectorAll('button')].map((b) => b.getAttribute('data-testid') ?? b.getAttribute('aria-label'));
    expect([...names].sort(), `the head's buttons: ${JSON.stringify(names)}`).toEqual(['room-head-add', 'room-head-menu', koMessages.chats.editRoomName].sort());
    expect(container.querySelector('[data-testid="room-bar"]')).toBeNull();
  });

  it('⭐ a PHONE (below lg): the room\'s name · people · «⋯» are in the shell\'s header row — ONE h1, no second head block; the people button opens the participants and the «+»', async () => {
    belowLg.current = true;
    groupRoom();
    await mount();
    expect(container.querySelector('[data-testid="room-head"]'), 'no in-column head on a phone (it cost 135 px of reading column)').toBeNull();
    const bar = container.querySelector('[data-testid="room-bar"]') as HTMLElement;
    expect(bar.querySelector('h1')?.textContent).toContain('팀 채널'); // reverted (the head stays a block under the shell row) → no bar
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const people = bar.querySelector('[data-testid="room-bar-people"]') as HTMLElement;
    expect(people.textContent, 'the fixed name + the number: «참여자 보기 2»').toBe(`${koMessages.chats.roomPeopleOpen} 2`);
    expect(container.querySelector('[data-testid="room-head-menu"]'), 'the «⋯» menu rides in the header row\'s actions').not.toBeNull();
    await act(async () => { people.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    const popup = document.querySelector('[data-testid="room-bar-people-popup"]') as HTMLElement;
    expect(popup.querySelectorAll('[data-testid="room-head-chip"]')).toHaveLength(2);
    expect(popup.querySelector('[data-testid="room-head-add"]')).not.toBeNull();
    // the «+» closes the popover and opens the add dialog — never both layers at once (two Escape presses)
    await act(async () => { (popup.querySelector('[data-testid="room-head-add"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="room-bar-people-popup"]'), 'the people popover is closed once the add dialog is asked for').toBeNull(); // reverted (the «+» only calls onAdd) → the popover stays open behind the dialog
  });

  it('the room menu\'s trigger is a 44 px press on touch (it rides in the phone\'s shell row now: it was a 28 px raw trigger)', async () => {
    belowLg.current = true;
    groupRoom();
    await mount();
    const trigger = container.querySelector('[data-testid="room-head-menu"]') as HTMLElement;
    expect(trigger.className).toContain('touch:min-h-11');
    expect(trigger.className).toContain('touch:min-w-11');
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

    const titleEl = container.querySelector('[data-testid="room-head"] h1'); // story 4887 — the name's weight sits on the head's h1
    expect(titleEl).not.toBeUndefined();
    expect(titleEl?.className).toContain('font-semibold');
    expect(titleEl?.className).not.toContain('font-medium');
  });

  // 카디르 QA독립검증(PR#3405) — PR-5 신규 테스트가 DM(plain span)만 렌더해 group(editable
  // 버튼 분기)의 동일 처방이 무테스트였던 갭. PR-6(#3405 이월분)에 편입.
  it('group 방이름(편집 가능 버튼 분기)도 font-semibold(Claim 무게)를 갖는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) {
        return {
          ok: true,
          json: async () => ({
            title: '팀 채널', type: 'group', muted: false, lastReadAt: null, freeResponse: false,
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

    const titleEl = container.querySelector('[data-testid="room-head"] h1');
    expect(titleEl?.textContent).toBe('팀 채널');
    expect(titleEl?.className).toContain('font-semibold');
    expect(titleEl?.className).not.toContain('font-medium');
  });
});

// story 4887 (UI-4 P3-a) — mute and notification settings live in the room head's «⋯» menu now: open it, then take the item
async function openHeadMenuItem(testId: string): Promise<HTMLElement> {
  const trigger = container.querySelector('[data-testid="room-head-menu"]') as HTMLElement | null;
  expect(trigger, 'the room head «⋯» menu').not.toBeNull();
  await act(async () => { trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const item = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  expect(item, `the «⋯» menu item ${testId}`).not.toBeNull();
  return item!;
}

// story #4179(E-PROD-ESC) — free_response가 단건 GET에 없어서 켜 둔 방을 새로 열면 「전달
// 설정」 토글이 off로 보였다(그대로 저장하면 꺼짐). BE가 이제 싣는 값으로 토글이 초기화되는지
// 실 마운트로 고정 — 「새로고침」 = 이 페이지를 새로 마운트해 단건 GET을 다시 읽는 것.
describe('ConversationPage — 전달 설정 free_response 초기값(story #4179)', () => {
  async function openDeliveryContractSwitch(freeResponse: boolean | undefined) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/conversations/conv-1')) {
        return {
          ok: true,
          json: async () => ({
            title: '팀 채널', type: 'group', muted: false, last_read_at: null,
            ...(freeResponse === undefined ? {} : { free_response: freeResponse }),
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

    const settingsItem = await openHeadMenuItem('room-head-settings');
    expect(settingsItem.textContent).toContain(koMessages.chats.deliveryContractTitle);
    await act(async () => { settingsItem.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const sw = document.querySelector(
      `[aria-label="${koMessages.chats.deliveryContractFreeResponseLabel}"]`,
    );
    expect(sw).not.toBeNull();
    return sw!;
  }

  it('서버가 free_response=true를 주면 다시 열어도 토글이 켜진 채 보인다', async () => {
    const sw = await openDeliveryContractSwitch(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('서버가 false를 주면 꺼진 채(음성대조 — 늘 켜짐으로 통과하는 허수아비 아님)', async () => {
    const sw = await openDeliveryContractSwitch(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });
});
