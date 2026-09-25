// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import {
  FirstInstructionRedirect,
  MAX_COMPOSE_LENGTH,
  buildFirstInstructionTarget,
  participantsIncludeAgent,
  pickNewestAgentDm,
  type ConversationLite,
} from './first-instruction-redirect';
import { DEFAULT_NAV_V3_FLAGS, type NavV3Flags } from '@/lib/nav-v3-destinations';

const CHAT_V3_ON: NavV3Flags = { ...DEFAULT_NAV_V3_FLAGS, chatV3Enabled: true };

const routerReplaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
}));

const createConversationMock = vi.fn();
vi.mock('@/lib/onboarding/first-instruction', () => ({
  createFirstInstructionConversation: (...args: unknown[]) => createConversationMock(...args),
}));

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agentId = 'agent-1';

interface StubOpts {
  agentMemberIds?: string[]; // 이 프로젝트 에이전트 멤버(기본: agent 포함)
  agentMembersOk?: boolean; // team-members 조회 성공 여부(기본 true)
  conversations?: ConversationLite[]; // 전체 목록(스텁이 페이지네이션)
  conversationsOk?: boolean; // 목록 조회 성공 여부(기본 true)
  checklistId?: string | null;
  checklistProjectId?: string | null; // story #4231 — 체크리스트 대화의 프로젝트(없으면 옛 응답)
  byId?: Record<string, { participants?: { member_id: string }[] } | null>; // GET /{id} (null=조회 실패)
}

// GET /{id}의 기본 참가자 = agent 포함(생성 후 재확認이 통과하도록). 명시 byId로 덮어씀.
function stubFetch(opts: StubOpts) {
  const PAGE = 100;
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/team-members')) {
      if (opts.agentMembersOk === false) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      const ids = opts.agentMemberIds ?? [agentId];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: ids.map((id) => ({ id })) }) });
    }
    if (url.startsWith('/api/conversations?')) {
      if (opts.conversationsOk === false) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      const all = opts.conversations ?? [];
      const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset') ?? '0');
      const slice = all.slice(offset, offset + PAGE);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: slice, total: all.length }) });
    }
    if (url.startsWith('/api/activation/checklist')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { first_instruction_conversation_id: opts.checklistId ?? null, first_instruction_conversation_project_id: opts.checklistProjectId } }) });
    }
    if (url.startsWith('/api/conversations/')) {
      const id = url.slice('/api/conversations/'.length);
      const rec = opts.byId?.[id];
      if (rec === null) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      const conv = rec ?? { participants: [{ member_id: agentId }] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(conv) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

let container: HTMLDivElement;
let root: Root;

async function renderRedirect(props: { agentId: string | null; compose: string; projectId: string | null; flags?: NavV3Flags }) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <FirstInstructionRedirect {...props} />
      </NextIntlClientProvider>,
    );
  });
  // 효과 안 여러 await(멤버십→목록→체크리스트→상세→생성) 소진.
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  routerReplaceMock.mockReset();
  createConversationMock.mockReset();
  fetchWithAuthMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function agentDm(id: string, updated_at: string): ConversationLite {
  return { id, type: 'dm', updated_at, participants: [{ member_id: agentId, type: 'agent' }, { member_id: 'me', type: 'human' }] };
}

describe('pickNewestAgentDm / participantsIncludeAgent (순수)', () => {
  it('참가자에 에이전트 있으면 true', () => {
    expect(participantsIncludeAgent([{ member_id: agentId }], agentId)).toBe(true);
    expect(participantsIncludeAgent([{ member_id: 'x' }], agentId)).toBe(false);
    expect(participantsIncludeAgent(undefined, agentId)).toBe(false);
  });
  it('에이전트 DM 최신 1건', () => {
    const convs = [agentDm('c-old', '2026-09-17T01:00:00Z'), agentDm('c-new', '2026-09-17T05:00:00Z')];
    expect(pickNewestAgentDm(convs, agentId)).toBe('c-new');
  });
  it('에이전트 DM 없으면 null(→ 생성)', () => {
    const convs: ConversationLite[] = [{ id: 'g', type: 'group', participants: [{ member_id: agentId }] }];
    expect(pickNewestAgentDm(convs, agentId)).toBeNull();
  });
});

describe('buildFirstInstructionTarget (순수)', () => {
  it('chatV3 OFF — 빈 compose는 compose 없이', () => {
    expect(buildFirstInstructionTarget('c1', '', DEFAULT_NAV_V3_FLAGS)).toEqual({ path: '/chats/c1', tooLong: false });
  });
  it('chatV3 OFF — 일반 compose는 인코딩해 실음', () => {
    expect(buildFirstInstructionTarget('c1', '디자인 시안 만들어 줘', DEFAULT_NAV_V3_FLAGS)).toEqual({
      path: `/chats/c1?compose=${encodeURIComponent('디자인 시안 만들어 줘')}`,
      tooLong: false,
    });
  });
  it('chatV3 OFF — 상한 초과는 싣지 않고 tooLong', () => {
    expect(buildFirstInstructionTarget('c1', 'x'.repeat(MAX_COMPOSE_LENGTH + 1), DEFAULT_NAV_V3_FLAGS)).toEqual({ path: '/chats/c1', tooLong: true });
  });

  // story #4158 AC1 — chatV3 ON: v3 셸 딥링크(4404 ?conversation=+4408 ?compose= 계약).
  it('⭐chatV3 ON — 빈 compose는 conversation만', () => {
    expect(buildFirstInstructionTarget('c1', '', CHAT_V3_ON)).toEqual({ path: '/chat?conversation=c1', tooLong: false });
  });
  it('⭐chatV3 ON — 일반 compose는 conversation+compose 둘 다(& 결합)', () => {
    expect(buildFirstInstructionTarget('c1', '디자인 시안 만들어 줘', CHAT_V3_ON)).toEqual({
      path: `/chat?conversation=c1&compose=${encodeURIComponent('디자인 시안 만들어 줘')}`,
      tooLong: false,
    });
  });
  it('⭐chatV3 ON — 상한 초과는 compose 없이 conversation만·tooLong', () => {
    expect(buildFirstInstructionTarget('c1', 'x'.repeat(MAX_COMPOSE_LENGTH + 1), CHAT_V3_ON)).toEqual({
      path: '/chat?conversation=c1',
      tooLong: true,
    });
  });
});

describe('FirstInstructionRedirect (동작)', () => {
  it('기존 에이전트 DM이 있으면 그 대화로 이동·생성 0(양성대조: 찾기 빼면 RED)', async () => {
    stubFetch({ conversations: [agentDm('c-existing', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '한 줄 지시', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).toHaveBeenCalledWith(`/chats/c-existing?compose=${encodeURIComponent('한 줄 지시')}&p=proj-1`);
  });

  it('없으면 createFirstInstructionConversation 1회(생성 후 참가자 재확認) 후 이동', async () => {
    stubFetch({ conversations: [], byId: { 'c-new': { participants: [{ member_id: agentId }] } } });
    createConversationMock.mockResolvedValue('c-new');
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).toHaveBeenCalledWith('proj-1', agentId);
    expect(routerReplaceMock).toHaveBeenCalledWith('/chats/c-new?p=proj-1');
  });

  it('① 체크리스트 id는 그 대화에 에이전트가 있을 때만(GET /{id} 확認) 채택', async () => {
    stubFetch({
      checklistId: 'c-check',
      conversations: [agentDm('c-list', '2026-09-17T02:00:00Z')],
      byId: { 'c-check': { participants: [{ member_id: agentId }, { member_id: 'me' }] } },
    });
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).toHaveBeenCalledWith('/chats/c-check?p=proj-1');
  });

  it('⭐story #4231 — 체크리스트 대화가 다른 프로젝트면 착지 `?p=`는 그 대화의 프로젝트(온보딩 프로젝트 아님)', async () => {
    stubFetch({
      checklistId: 'c-check',
      checklistProjectId: 'proj-9',
      conversations: [agentDm('c-list', '2026-09-17T02:00:00Z')],
      byId: { 'c-check': { participants: [{ member_id: agentId }, { member_id: 'me' }] } },
    });
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(routerReplaceMock).toHaveBeenCalledWith('/chats/c-check?p=proj-9');
  });

  it('생성 뒤 재마운트(새로고침 동형)면 ②에서 찾아 생성 0', async () => {
    stubFetch({ conversations: [], byId: { 'c-1': { participants: [{ member_id: agentId }] } } });
    createConversationMock.mockResolvedValue('c-1');
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    createConversationMock.mockClear();
    stubFetch({ conversations: [agentDm('c-1', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).toHaveBeenLastCalledWith('/chats/c-1?p=proj-1');
  });

  it('생성 null이면 이동 0·안내(AC3)', async () => {
    stubFetch({ conversations: [] });
    createConversationMock.mockResolvedValue(null);
    await renderRedirect({ agentId, compose: 'x', projectId: 'proj-1' });
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionErrorTitle);
  });

  it('compose 상한 초과면 이동 0·대화 열기 안내(AC3)', async () => {
    stubFetch({ conversations: [agentDm('c-x', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: 'x'.repeat(MAX_COMPOSE_LENGTH + 1), projectId: 'proj-1' });
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionTooLongTitle);
  });

  it('agent·project 없으면 안내(생성·이동 0)', async () => {
    stubFetch({ conversations: [] });
    await renderRedirect({ agentId: null, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionErrorTitle);
  });

  it('AC5 — 이 진입은 메시지 전송 API를 부르지 않는다', async () => {
    stubFetch({ conversations: [agentDm('c-existing', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '한 줄', projectId: 'proj-1' });
    const urls = fetchWithAuthMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /\/messages\b/.test(u))).toBe(false);
    // 발신은 POST — 목록/멤버십/상세/체크리스트는 전부 GET(옵션 인자 없이 호출).
    expect(fetchWithAuthMock.mock.calls.every((c) => c[1] === undefined)).toBe(true);
  });

  // ── PO CHANGES3 추가 4 ──
  it('일반 멤버 — 대화 목록을 include_agent_conversations 없이 기본 목록으로 조회', async () => {
    stubFetch({ conversations: [agentDm('c-1', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    const listCalls = fetchWithAuthMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/conversations?'));
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((u) => !u.includes('include_agent_conversations'))).toBe(true);
  });

  it('대화 목록 조회 실패(500)면 생성 0·안내', async () => {
    stubFetch({ conversationsOk: false, conversations: [] });
    createConversationMock.mockResolvedValue('should-not-be-used');
    await renderRedirect({ agentId, compose: 'x', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionErrorTitle);
  });

  it('첫 페이지(100) 밖 DM도 페이지네이션으로 찾음·생성 0', async () => {
    const bulk: ConversationLite[] = Array.from({ length: 100 }, (_, i) => ({
      id: `noise-${i}`, type: 'dm', updated_at: '2026-09-17T00:00:00Z', participants: [{ member_id: 'other' }],
    }));
    bulk.push(agentDm('c-page2', '2026-09-17T09:00:00Z')); // 101번째
    stubFetch({ conversations: bulk });
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).toHaveBeenCalledWith('/chats/c-page2?p=proj-1');
  });

  it('다른 org 에이전트(프로젝트 멤버 아님·생성 API는 id 반환 모양)면 생성 前 error·이동 0', async () => {
    // 멤버십에 agentId 없음 → 생성 자체를 안 부른다(생성 API가 id를 돌려줘도 도달 X).
    stubFetch({ agentMemberIds: ['someone-else'], conversations: [] });
    createConversationMock.mockResolvedValue('solo-room-id');
    await renderRedirect({ agentId, compose: 'x', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionErrorTitle);
  });

  it('생성됐는데 참가자에 에이전트가 없으면(드롭) 이동 0·안내(생성측 방어)', async () => {
    stubFetch({ conversations: [], byId: { 'dropped-room': { participants: [{ member_id: 'me' }] } } });
    createConversationMock.mockResolvedValue('dropped-room');
    await renderRedirect({ agentId, compose: 'x', projectId: 'proj-1' });
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionErrorTitle);
  });

  // story #4231 3차 · 까디르 QA(ccef5258a) — 첫 착지·안내 링크는 이 온보딩의 프로젝트(`p`)를 싣는다(기존 쿼리 글자는 그대로).
  // ── story #4158 AC1 — chatV3 ON ──
  it('⭐chatV3 ON — 기존 대화면 v3 셸 딥링크(?conversation=+&compose=)로 이동', async () => {
    stubFetch({ conversations: [agentDm('c-existing', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '한 줄 지시', projectId: 'proj-1', flags: CHAT_V3_ON });
    expect(routerReplaceMock).toHaveBeenCalledWith(
      `/chat?conversation=c-existing&compose=${encodeURIComponent('한 줄 지시')}&p=proj-1`,
    );
  });

  it('⭐chatV3 ON — compose 상한 초과면 이동 0·「대화 열기」 안내가 v3 셸(conversation만)로', async () => {
    stubFetch({ conversations: [agentDm('c-x', '2026-09-17T10:00:00Z')] });
    await renderRedirect({
      agentId, compose: 'x'.repeat(MAX_COMPOSE_LENGTH + 1), projectId: 'proj-1', flags: CHAT_V3_ON,
    });
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionTooLongTitle);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/chat?conversation=c-x&p=proj-1');
  });

  it('⭐chatV3 ON — agent·project 없으면 안내의 「목록으로」 링크가 /chat', async () => {
    stubFetch({ conversations: [] });
    await renderRedirect({ agentId: null, compose: '', projectId: 'proj-1', flags: CHAT_V3_ON });
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionErrorTitle);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/chat?p=proj-1');
  });
});
