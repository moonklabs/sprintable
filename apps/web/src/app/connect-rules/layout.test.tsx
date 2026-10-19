// @vitest-environment jsdom
//
// story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N) — 「오늘」#3962 선례 동형: `/connect-rules`가
// (authenticated) 밖이라도 세션 가드는 그대로 서야 한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { RealtimeProvider } from '@/components/realtime-provider';

const { getServerSessionMock, redirectMock, headersMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  headersMock: vi.fn(async () => new Map([['x-pathname', '/connect-rules']])),
}));

vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));

import ConnectRulesV3Layout from './layout';

describe('/connect-rules layout — 세션 가드', () => {
  afterEach(() => {
    getServerSessionMock.mockReset();
    redirectMock.mockClear();
  });

  it('⭐세션 없음 — /login으로 리다이렉트(next=/connect-rules)', async () => {
    getServerSessionMock.mockResolvedValue(null);
    await expect(ConnectRulesV3Layout({ children: 'x' })).rejects.toThrow(
      'REDIRECT:/login?next=%2Fconnect-rules&reason=session_expired',
    );
  });

  it('세션 있음 — children을 그대로 통과', async () => {
    getServerSessionMock.mockResolvedValue({ user_id: 'u1', email: 'a@b.com', access_token: 'tok' });
    const result = await ConnectRulesV3Layout({ children: 'children-marker' });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
  // story #4698 — 하단 탭 배지(useChatUnreadTotal)가 독립 EventSource로 폴백하던 길을 지웠으니, 이 레이아웃이 스트림 하나(RealtimeProvider)를 둔다.
  it('⭐세션 있음 — children을 RealtimeProvider(탭당 스트림 1개)로 감싼다', async () => {
    getServerSessionMock.mockResolvedValue({ user_id: 'u1', email: 'a@b.com', access_token: 'tok' });
    const result = (await ConnectRulesV3Layout({ children: 'children-marker' })) as ReactElement<{ children: ReactElement }>;
    const inner = result.props.children;
    expect(inner.type).toBe(RealtimeProvider);
    expect((inner.props as { children: unknown }).children).toBe('children-marker');
  });

});
