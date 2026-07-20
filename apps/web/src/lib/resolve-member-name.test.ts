// story #2056 — 조직 브리핑/사이드바 인사가 계정 핸들("sellerking")을 쓰던 회귀 재현.
// `/api/v2/me`의 name은 org-level grant-only/owner 휴먼일 때 User.display_name(계정 핸들)로
// 폴백하지만, `/api/v2/team-members`(org-level)는 org_members SSOT를 직접 해소해 올바른
// 조직 내 이름을 돌려준다(id로 교차조회 가능). 이 테스트는 그 교차조회 로직 자체를 잠근다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOrgMemberName } from './resolve-member-name';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveOrgMemberName — story #2056', () => {
  it('team-members에서 id가 일치하는 멤버의 name을 쓴다(계정 핸들 아님)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { id: 'other-member', name: '다른 사람' },
          { id: 'me-id-1', name: '송윤재' },
        ],
      })),
    );

    const name = await resolveOrgMemberName('http://fastapi', {}, 'me-id-1', 'sellerking');
    expect(name).toBe('송윤재');
  });

  it('team-members 조회 실패 시 계정 이름으로 폴백한다(AC2)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const name = await resolveOrgMemberName('http://fastapi', {}, 'me-id-1', 'sellerking');
    expect(name).toBe('sellerking');
  });

  it('id가 목록에 없으면 계정 이름으로 폴백한다(AC2)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [{ id: 'someone-else', name: '다른 사람' }] })),
    );
    const name = await resolveOrgMemberName('http://fastapi', {}, 'me-id-1', 'sellerking');
    expect(name).toBe('sellerking');
  });

  it('meId가 없으면 fetch 없이 계정 이름으로 폴백한다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const name = await resolveOrgMemberName('http://fastapi', {}, undefined, 'sellerking');
    expect(name).toBe('sellerking');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
