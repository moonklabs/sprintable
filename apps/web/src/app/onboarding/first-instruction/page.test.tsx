// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getServerSessionMock = vi.fn();
vi.mock('@/lib/db/server', () => ({
  getServerSession: () => getServerSessionMock(),
}));

// redirect()는 실제로 NEXT_REDIRECT를 throw해 렌더를 중단한다 — 페이크도 던져 흐름을 끊고 인자를 잡는다.
const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}));

// 클라이언트 자식은 스텁 — 페이지가 반환하는 React element의 props(자식에 넘긴 값)만 본다.
vi.mock('./first-instruction-redirect', () => ({
  FirstInstructionRedirect: () => null,
}));

import FirstInstructionPage from './page';

beforeEach(() => {
  getServerSessionMock.mockReset();
  redirectMock.mockClear();
});

describe('FirstInstructionPage (서버)', () => {
  it('로그인 안 됨 → /login?next=<이 주소(agent·compose 보존)>로 리다이렉트', async () => {
    getServerSessionMock.mockResolvedValue(null);
    await expect(
      FirstInstructionPage({ searchParams: Promise.resolve({ agent: 'agent-1', compose: '한 줄' }) }),
    ).rejects.toThrow('REDIRECT:');
    const target = redirectMock.mock.calls[0][0] as string;
    expect(target.startsWith('/login?next=')).toBe(true);
    const next = decodeURIComponent(target.slice('/login?next='.length));
    expect(next).toContain('/onboarding/first-instruction');
    expect(next).toContain('agent=agent-1');
    expect(next).toContain('compose=');
  });

  it('로그인됨 → 세션 기본 프로젝트를 자식에 넘김(리다이렉트 0)', async () => {
    getServerSessionMock.mockResolvedValue({
      user_id: 'me',
      email: 'me@x.dev',
      access_token: 'tok',
      org_id: 'org-1',
      project_id: 'proj-9',
    });
    const out = (await FirstInstructionPage({
      searchParams: Promise.resolve({ agent: 'agent-1', compose: 'x' }),
    })) as unknown as { props: { agentId: string; compose: string; projectId: string } };
    expect(redirectMock).not.toHaveBeenCalled();
    expect(out.props.agentId).toBe('agent-1');
    expect(out.props.compose).toBe('x');
    expect(out.props.projectId).toBe('proj-9');
  });

  // story #4158 — 임시 readNavV3Flags()가 개별 isXEnabled() 3개를 그대로 위임하는지.
  it('⭐chatV3Enabled 플래그를 읽어 자식에 넘김', async () => {
    const original = process.env.CHAT_V3_ENABLED;
    process.env.CHAT_V3_ENABLED = 'true';
    getServerSessionMock.mockResolvedValue({
      user_id: 'me', email: 'me@x.dev', access_token: 'tok', org_id: 'org-1', project_id: 'proj-9',
    });
    const out = (await FirstInstructionPage({
      searchParams: Promise.resolve({ agent: 'agent-1', compose: 'x' }),
    })) as unknown as { props: { flags: { chatV3Enabled: boolean } } };
    expect(out.props.flags.chatV3Enabled).toBe(true);
    process.env.CHAT_V3_ENABLED = original;
  });
});
