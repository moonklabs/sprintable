import { describe, expect, it } from 'vitest';
import { canEditOrgMemberRole, orgRoleLabel } from './org-member-role';

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

describe('orgRoleLabel(story #3770 — 원시 role 값 t() 없이 노출 재발 방지)', () => {
  const t = (key: string) => ({ roleOwner: '소유자', roleAdmin: '관리자', roleMember: '구성원' }[key] ?? `[${key}]`);

  it('⭐owner/admin/member 셋 다 번역된 값을 돌려준다(설정 프로필 「역할 admin」 실사고 재현)', () => {
    expect(orgRoleLabel('owner', t)).toBe('소유자');
    expect(orgRoleLabel('admin', t)).toBe('관리자');
    expect(orgRoleLabel('member', t)).toBe('구성원');
  });

  // 뮤테이션 대조 — 원시 값을 그대로 돌려주면(번역 호출 자체를 빼면) 이 자리가 반드시
  // 잡아낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — t() 호출 없이 원문 그대로 돌려주면 이 테스트가 FAIL한다(가드 자체 검산)', () => {
    const identity = (v: string) => orgRoleLabel(v, (k) => k);
    expect(identity('admin')).not.toBe('관리자');
    expect(identity('admin')).toBe('roleAdmin');
  });

  it('음성대조 — 알려지지 않은 값(엔티티 시드 오류 등)은 원문을 그대로 돌려준다(지어내지 않는다)', () => {
    expect(orgRoleLabel('unknown-role', t)).toBe('unknown-role');
  });
});
