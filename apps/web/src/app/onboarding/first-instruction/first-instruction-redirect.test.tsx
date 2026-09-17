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
  pickExistingConversationId,
  type ConversationLite,
} from './first-instruction-redirect';

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

// fetchWithAuth를 URL로 분기하는 페이크 — checklist·conversations만 답한다(그 밖은 404).
function stubFetch(opts: { checklistId?: string | null; conversations?: ConversationLite[] }) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/activation/checklist')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { first_instruction_conversation_id: opts.checklistId ?? null } }),
      });
    }
    if (url.startsWith('/api/conversations')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: opts.conversations ?? [] }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

let container: HTMLDivElement;
let root: Root;

async function renderRedirect(props: { agentId: string | null; compose: string; projectId: string | null }) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <FirstInstructionRedirect {...props} />
      </NextIntlClientProvider>,
    );
  });
  // useEffect 안 fetch/create 프로미스 소진.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
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

const agentId = 'agent-1';
function agentDm(id: string, updated_at: string): ConversationLite {
  return { id, type: 'dm', updated_at, participants: [{ member_id: agentId, type: 'agent' }, { member_id: 'me', type: 'human' }] };
}

describe('pickExistingConversationId (순수)', () => {
  it('① 체크리스트 id가 그 에이전트 참가 대화면 그 id', () => {
    const convs = [agentDm('c-check', '2026-09-17T10:00:00Z'), agentDm('c-other', '2026-09-17T12:00:00Z')];
    expect(pickExistingConversationId('c-check', convs, agentId)).toBe('c-check');
  });
  it('① 체크리스트 대화에 그 에이전트가 없으면 ②로(최신 에이전트 DM)', () => {
    const notAgent: ConversationLite = { id: 'c-check', type: 'dm', updated_at: '2026-09-17T09:00:00Z', participants: [{ member_id: 'other-agent' }] };
    const convs = [notAgent, agentDm('c-a', '2026-09-17T08:00:00Z'), agentDm('c-b', '2026-09-17T12:00:00Z')];
    expect(pickExistingConversationId('c-check', convs, agentId)).toBe('c-b');
  });
  it('② 체크리스트 없으면 최신 에이전트 DM', () => {
    const convs = [agentDm('c-old', '2026-09-17T01:00:00Z'), agentDm('c-new', '2026-09-17T05:00:00Z')];
    expect(pickExistingConversationId(null, convs, agentId)).toBe('c-new');
  });
  it('에이전트 DM이 없으면 null(→ 생성 경로)', () => {
    const convs: ConversationLite[] = [{ id: 'g', type: 'group', participants: [{ member_id: agentId }] }];
    expect(pickExistingConversationId(null, convs, agentId)).toBeNull();
  });
});

describe('buildFirstInstructionTarget (순수)', () => {
  it('빈 compose는 compose 없이', () => {
    expect(buildFirstInstructionTarget('c1', '')).toEqual({ path: '/chats/c1', tooLong: false });
  });
  it('일반 compose는 인코딩해 실음', () => {
    expect(buildFirstInstructionTarget('c1', '디자인 시안 만들어 줘')).toEqual({
      path: `/chats/c1?compose=${encodeURIComponent('디자인 시안 만들어 줘')}`,
      tooLong: false,
    });
  });
  it('상한 초과는 싣지 않고 tooLong', () => {
    const long = 'x'.repeat(MAX_COMPOSE_LENGTH + 1);
    expect(buildFirstInstructionTarget('c1', long)).toEqual({ path: '/chats/c1', tooLong: true });
  });
});

describe('FirstInstructionRedirect (동작)', () => {
  it('기존 에이전트 DM이 있으면 그 대화로 이동·생성 0(양성대조: 찾기 빼면 이 테스트 RED)', async () => {
    stubFetch({ checklistId: null, conversations: [agentDm('c-existing', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '한 줄 지시', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).toHaveBeenCalledWith(`/chats/c-existing?compose=${encodeURIComponent('한 줄 지시')}`);
  });

  it('없으면 createFirstInstructionConversation 1회 후 그 대화로', async () => {
    stubFetch({ checklistId: null, conversations: [] });
    createConversationMock.mockResolvedValue('c-new');
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).toHaveBeenCalledWith('proj-1', agentId);
    expect(routerReplaceMock).toHaveBeenCalledWith('/chats/c-new');
  });

  it('생성 뒤 재마운트(새로고침 동형)면 ②에서 찾아 생성 0', async () => {
    // 1차: 없음 → 생성 c-1.
    stubFetch({ checklistId: null, conversations: [] });
    createConversationMock.mockResolvedValue('c-1');
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    // 2차(재마운트): 목록에 c-1이 이미 있음 → 생성 안 함.
    await act(async () => root.unmount());
    root = createRoot(container);
    createConversationMock.mockClear();
    stubFetch({ checklistId: 'c-1', conversations: [agentDm('c-1', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '', projectId: 'proj-1' });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(routerReplaceMock).toHaveBeenLastCalledWith('/chats/c-1');
  });

  it('다른 org·없는 멤버(생성 null)면 이동 0·안내 표시(AC3)', async () => {
    stubFetch({ checklistId: null, conversations: [] });
    createConversationMock.mockResolvedValue(null);
    await renderRedirect({ agentId, compose: 'x', projectId: 'proj-1' });
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.onboarding.firstInstructionErrorTitle);
  });

  it('compose 상한 초과면 이동 0·대화 열기 안내(AC3)', async () => {
    stubFetch({ checklistId: null, conversations: [agentDm('c-x', '2026-09-17T10:00:00Z')] });
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
    stubFetch({ checklistId: null, conversations: [agentDm('c-existing', '2026-09-17T10:00:00Z')] });
    await renderRedirect({ agentId, compose: '한 줄', projectId: 'proj-1' });
    const calledUrls = fetchWithAuthMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => /\/messages/.test(u))).toBe(false);
    expect(calledUrls.some((u) => u.includes('method') )).toBe(false);
  });
});
