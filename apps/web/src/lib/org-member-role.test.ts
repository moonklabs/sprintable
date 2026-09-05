import { describe, expect, it } from 'vitest';
import { canEditOrgMemberRole } from './org-member-role';

describe('canEditOrgMemberRole(story #3491, BE org_members.py::update_org_member 미러)', () => {
  it('⭐admin caller — owner도 자기 자신도 아닌 member는 편집 가능(FE=BE 폭 정정의 핵심)', () => {
    expect(canEditOrgMemberRole({
      currentRole: 'admin', currentUserId: 'u-admin', member: { role: 'member', user_id: 'u-other' },
    })).toBe(true);
  });

  it('member caller — 아무도 편집 못 한다', () => {
    expect(canEditOrgMemberRole({
      currentRole: 'member', currentUserId: 'u-member', member: { role: 'member', user_id: 'u-other' },
    })).toBe(false);
  });

  it('대상이 owner면 caller가 owner여도 admin이어도 이 화면에선 편집 불가(항상 Badge)', () => {
    expect(canEditOrgMemberRole({
      currentRole: 'owner', currentUserId: 'u-owner', member: { role: 'owner', user_id: 'u-other' },
    })).toBe(false);
    expect(canEditOrgMemberRole({
      currentRole: 'admin', currentUserId: 'u-admin', member: { role: 'owner', user_id: 'u-other' },
    })).toBe(false);
  });

  it('⭐자기 자신 행은 caller가 owner여도 admin이어도 편집 불가', () => {
    expect(canEditOrgMemberRole({
      currentRole: 'admin', currentUserId: 'u-self', member: { role: 'admin', user_id: 'u-self' },
    })).toBe(false);
    expect(canEditOrgMemberRole({
      currentRole: 'owner', currentUserId: 'u-self', member: { role: 'admin', user_id: 'u-self' },
    })).toBe(false);
  });

  it('currentUserId 미로딩(null/undefined)이면 자기 자신 판정을 안 하고 정상 진행(서버가 최종 방어선)', () => {
    expect(canEditOrgMemberRole({
      currentRole: 'admin', currentUserId: undefined, member: { role: 'member', user_id: 'u-other' },
    })).toBe(true);
  });

  it('member.user_id가 null(연결 해제된 사용자 등)이면 자기 자신으로 오판하지 않는다', () => {
    expect(canEditOrgMemberRole({
      currentRole: 'admin', currentUserId: 'u-admin', member: { role: 'member', user_id: null },
    })).toBe(true);
  });

  it('owner caller — admin/member 서로를 편집 가능(회귀 0)', () => {
    expect(canEditOrgMemberRole({
      currentRole: 'owner', currentUserId: 'u-owner', member: { role: 'admin', user_id: 'u-other' },
    })).toBe(true);
  });
});
