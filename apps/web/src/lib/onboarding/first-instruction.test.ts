// @vitest-environment jsdom
//
// story #3994(«거짓 경고» 클래스, PO 확定) — 체크리스트 폴백 경로(agentId 미지정)가
// 프로젝트의 "첫 에이전트"를 골라 DM을 연다. 「시스템 발행」이 정렬상 첫 행이면 이
// 폴백이 그리로 첫 지시 DM을 열어버릴 잠재 결함(연결 대상이 아닌 내부 멤버 — 지시를
// 보내도 아무 반응이 없다) — 골라내고 그다음 실 에이전트를 쓴다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFirstInstructionConversation } from './first-instruction';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubTeamMembers(agents: { id: string; runtime_type?: string | null }[]) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/team-members?')) {
      return { ok: true, json: async () => ({ data: agents }) };
    }
    if (url === '/api/conversations' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { participant_ids: string[] };
      return { ok: true, json: async () => ({ id: `conv-${body.participant_ids[0]}` }) };
    }
    return { ok: false, json: async () => null };
  });
}

describe('createFirstInstructionConversation — 시스템 발행 제외(story #3994)', () => {
  it('⭐목록 첫 행이 「시스템 발행」이면 건너뛰고 그다음 실 에이전트로 DM을 연다', async () => {
    stubTeamMembers([
      { id: 'sp1', runtime_type: 'system-publisher' },
      { id: 'a1', runtime_type: 'claude-code' },
    ]);
    const conversationId = await createFirstInstructionConversation('p1');
    expect(conversationId).toBe('conv-a1');
  });

  it('시스템 발행이 없으면(기존 동작 회귀 0) 첫 에이전트 그대로', async () => {
    stubTeamMembers([{ id: 'a1', runtime_type: 'claude-code' }]);
    const conversationId = await createFirstInstructionConversation('p1');
    expect(conversationId).toBe('conv-a1');
  });

  it('전부 시스템 발행뿐이면(실 에이전트 0) null(지어내지 않는다)', async () => {
    stubTeamMembers([{ id: 'sp1', runtime_type: 'system-publisher' }]);
    const conversationId = await createFirstInstructionConversation('p1');
    expect(conversationId).toBeNull();
  });

  it('agentId가 명시되면(connect-step 경로) 목록 조회 자체를 안 한다(회귀 0)', async () => {
    stubTeamMembers([{ id: 'sp1', runtime_type: 'system-publisher' }]);
    const conversationId = await createFirstInstructionConversation('p1', 'a-explicit');
    expect(conversationId).toBe('conv-a-explicit');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/team-members'))).toBe(false);
  });
});
