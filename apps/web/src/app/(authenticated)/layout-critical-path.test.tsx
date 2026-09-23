// story #4219 F1 + D1(PO 판정) — `(authenticated)` 레이아웃의 첫 문서 임계 경로 핀. dev 실측(로그 대조 · 13회): /flow SSR
// 중앙 408ms 중 B그룹(`/projects/{id}` ∥ `/activation/checklist`)이 126ms · 그 긴 장대는 checklist였다.
// - F1: 이 org의 표시용 힌트 쿠키가 있으면 checklist를 서버에서 기다리지 않는다(complete → 배너 0 · incomplete → 배너
//   자기 스켈레톤 · 없음/다른 org → 예전처럼 await).
// - D1: proxy resolve가 slug를, 멤버십이 이름을 이미 줬으면 `/projects/{id}`를 다시 부르지 않는다.
// 레이아웃 함수를 직접 불러 **어떤 백엔드 호출을 기다리는지**를 잰다(렌더는 안 함 — 반환 JSX의 props만 본다).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const req = { headers: new Headers(), cookies: new Map<string, string>() };
vi.mock('next/headers', () => ({
  headers: async () => req.headers,
  cookies: async () => ({ get: (name: string) => (req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined) }),
}));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock('@/lib/db/server', () => ({ getServerSession: async () => ({ access_token: 't', org_id: 'org-1' }) }));
vi.mock('../dashboard/dashboard-shell', () => ({ DashboardShell: () => null }));
vi.mock('@/components/storage/storage-capacity-toast-provider', () => ({ StorageCapacityToastProvider: () => null }));
vi.mock('@/components/chat/cross-project-toast-provider', () => ({ CrossProjectToastProvider: () => null }));
vi.mock('@/ee/components/billing/au-usage-banner', () => ({ AuUsageBanner: () => null }));

const calls: string[] = [];
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
beforeEach(() => {
  calls.length = 0;
  req.headers = new Headers({
    'x-pathname': '/moonklabs/sprintable/flow',
    'x-resolved-org-id': 'org-1',
    'x-resolved-project-id': 'proj-1',
    'x-resolved-project-slug': 'sprintable',
  });
  req.cookies = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/api/v2/me') return json({ id: 'tm-1', org_id: 'org-1', project_id: 'proj-1', project_name: 'Sprintable', name: 'U' });
    if (path === '/api/v2/me/memberships') return json([{ projectId: 'proj-1', projectName: 'Sprintable' }]);
    if (path === '/api/v2/organizations') return json([{ id: 'org-1', name: 'Moonklabs', slug: 'moonklabs', role: 'admin' }]);
    if (path === '/api/v2/activation/checklist') return json({ all_complete: false });
    if (path.startsWith('/api/v2/projects/')) return json({ name: 'Sprintable', slug: 'sprintable' });
    return json(null);
  }));
});

async function shellProps(): Promise<Record<string, unknown>> {
  const { default: AuthenticatedLayout } = await import('./layout');
  const el = (await AuthenticatedLayout({ children: null })) as ReactElement<Record<string, unknown>>;
  return el.props;
}

describe('(authenticated) 레이아웃 — 첫 문서 임계 경로(story #4219 F1·D1)', () => {
  it('⭐힌트 complete(이 org) → checklist 조회 0 · 완주 시드 true · 힌트 출처 표시(클라가 임계 경로 밖에서 재확인)', async () => {
    req.cookies.set('sp_activation_hint', 'org-1:complete');
    const props = await shellProps();
    expect(calls).not.toContain('/api/v2/activation/checklist');
    expect(props['initialActivationComplete']).toBe(true);
    expect(props['activationSeedFromHint']).toBe(true);
  });

  it('힌트 incomplete → checklist 조회 0 · 시드 없음(배너가 같은 크기 스켈레톤으로 자리 잡고 클라 조회로 채움)', async () => {
    req.cookies.set('sp_activation_hint', encodeURIComponent('org-1:incomplete'));
    const props = await shellProps();
    expect(calls).not.toContain('/api/v2/activation/checklist');
    expect(props['initialActivationComplete']).toBeUndefined();
    expect(props['activationSeedFromHint']).toBe(false);
  });

  it('힌트 없음 · 다른 org 힌트 → 예전처럼 서버에서 checklist를 기다린다(흔들림 0)', async () => {
    let props = await shellProps();
    expect(calls).toContain('/api/v2/activation/checklist');
    expect(props['initialActivationComplete']).toBe(false);
    calls.length = 0;
    req.cookies.set('sp_activation_hint', 'org-other:complete');
    props = await shellProps();
    expect(calls).toContain('/api/v2/activation/checklist');
    expect(props['activationSeedFromHint']).toBe(false);
  });

  it('⭐D1 — proxy가 slug를, 멤버십이 이름을 줬으면 /projects/{id} 조회 0 · slug는 헤더 값', async () => {
    const props = await shellProps();
    expect(calls.filter((c) => c.startsWith('/api/v2/projects'))).toEqual([]);
    expect(props['currentProjectSlug']).toBe('sprintable');
  });

  it('D1 대조 — slug 헤더가 없거나(캐시 이전 proxy) 멤버십에 없는 경로 프로젝트면 예전처럼 조회', async () => {
    req.headers.delete('x-resolved-project-slug');
    await shellProps();
    expect(calls).toContain('/api/v2/projects/proj-1');
    calls.length = 0;
    req.headers.set('x-resolved-project-slug', 'sprintable');
    req.headers.set('x-resolved-project-id', 'proj-other');
    await shellProps();
    expect(calls).toContain('/api/v2/projects/proj-other');
  });

  it('힌트 complete + D1 → 이 레이아웃의 백엔드 호출은 A그룹 셋뿐(B그룹 0)', async () => {
    req.cookies.set('sp_activation_hint', 'org-1:complete');
    await shellProps();
    expect([...calls].sort()).toEqual(['/api/v2/me', '/api/v2/me/memberships', '/api/v2/organizations']);
  });
});
