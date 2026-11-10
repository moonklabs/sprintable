// @vitest-environment jsdom
//
// story 4889 — useOrgAdmin: 역할 답 하나를 «지금 조직의 것»으로만 세고, 읽기가 실패해도 loaded가 끝난다(관리자가 아닌 것으로).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { fetchMeMock, orgRef } = vi.hoisted(() => ({ fetchMeMock: vi.fn(), orgRef: { current: 'org-1' as string | null } }));
vi.mock('@/lib/me-client', () => ({ fetchMe: fetchMeMock }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ orgId: orgRef.current }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { fetchMeMock.mockReset(); orgRef.current = 'org-1'; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount() {
  const { useOrgAdmin } = await import('./use-org-admin');
  function Probe() { const r = useOrgAdmin(); return <span data-testid="p">{`${r.isAdmin}|${r.loaded}`}</span>; }
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return () => container.querySelector('[data-testid="p"]')!.textContent;
}
const ok = (role: string) => ({ ok: true, json: async () => ({ data: { role } }) });

describe('useOrgAdmin (story 4889)', () => {
  it('admin · owner는 관리자, member는 아니다 — 답이 오면 loaded', async () => {
    fetchMeMock.mockResolvedValue(ok('owner'));
    expect((await mount())()).toBe('true|true');
  });
  it('member는 관리자가 아니다', async () => {
    fetchMeMock.mockResolvedValue(ok('member'));
    expect((await mount())()).toBe('false|true');
  });
  it('⭐읽기가 던져도(네트워크 끊김) 관리자가 아님으로 loaded가 끝난다 — 끝나지 않으면 접근권한 주소가 빈 본문으로 남는다', async () => {
    fetchMeMock.mockRejectedValue(new Error('network'));
    expect((await mount())()).toBe('false|true');
  });
  it('응답이 ok가 아니어도 관리자가 아님으로 끝난다', async () => {
    fetchMeMock.mockResolvedValue({ ok: false });
    expect((await mount())()).toBe('false|true');
  });
});
