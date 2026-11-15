// 4910 — 새 문서는 «첫 저장 때 만들기»라, 화면은 없는 slug 조회가 404인지로 초안 모드에 들어간다.
// 이 시험은 실제 ApiDocRepository + 실제 DocsService + 실제 route 오류 변환을 한 줄로 이어(BE 응답만 가짜) 400이 아니라 404가 나오는 것을 지킨다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiDocRepository } from '@sprintable/storage-api';

const { createDbServerClient, createAdminClient, getAuthContext } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext, getOrgProjectAuthContext: getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createDocRepository: vi.fn(async () => new ApiDocRepository('token')) }));

import { GET } from './route';

describe('GET /api/docs?slug= — 없는 slug (4910)', () => {
  beforeEach(() => {
    createDbServerClient.mockResolvedValue(null);
    createAdminClient.mockReturnValue(null);
    getAuthContext.mockResolvedValue({ id: 'm1', org_id: 'org-1', project_id: 'project-1', project_name: 'T', type: 'human', rateLimitExceeded: false });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [], meta: { has_more: false, next_cursor: null } }),
    })));
  });

  it('BE가 빈 목록을 주면 BFF는 404 NOT_FOUND(400 아님)', async () => {
    const res = await GET(new Request('http://localhost/api/docs?project_id=project-1&slug=untitled-123'));
    expect(res.status).toBe(404);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});
