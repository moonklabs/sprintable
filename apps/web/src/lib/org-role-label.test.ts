// story 4912 (D8) — ONE role label function for the agent list's second line and the detail head's chip.
import { describe, expect, it } from 'vitest';
import { agentRoleLabel, DEFAULT_ROLE_LABEL_KEY, ORG_ROLE_LABEL_KEY } from './org-role-label';

const t = (key: string) => `«${key}»`;

describe('agentRoleLabel — 목록과 상세가 같은 값을 같은 글자로', () => {
  it('⭐조직 역할(owner/admin/member)은 organization 라벨 키로 — 원문 «member»가 새지 않는다', () => {
    expect(agentRoleLabel('owner', t)).toBe('«roleGroupOwner»');
    expect(agentRoleLabel('admin', t)).toBe('«roleGroupAdmin»');
    expect(agentRoleLabel('member', t)).toBe('«roleGroupMember»');
  });

  it('⭐기본 직무 키(implementation · po · qa · design · devops)는 i18n 이름', () => {
    for (const [role, key] of Object.entries(DEFAULT_ROLE_LABEL_KEY)) expect(agentRoleLabel(role, t)).toBe(`«${key}»`);
    expect(Object.keys(DEFAULT_ROLE_LABEL_KEY).sort()).toEqual(['design', 'devops', 'implementation', 'po', 'qa']);
  });

  it('그 밖의 값은 원문 · 빈 값은 null · 프로토타입 이름(constructor)도 원문(함수 객체가 t()에 들어가지 않는다)', () => {
    expect(agentRoleLabel('my-custom-role', t)).toBe('my-custom-role');
    expect(agentRoleLabel('constructor', t)).toBe('constructor');
    expect(agentRoleLabel('toString', t)).toBe('toString');
    expect(agentRoleLabel('', t)).toBeNull();
    expect(agentRoleLabel(null, t)).toBeNull();
    expect(agentRoleLabel(undefined, t)).toBeNull();
  });

  it('조직 역할 표와 직무 키 표가 겹치지 않는다(한 값이 두 글자로 읽히지 않는다)', () => {
    for (const k of Object.keys(ORG_ROLE_LABEL_KEY)) expect(Object.hasOwn(DEFAULT_ROLE_LABEL_KEY, k)).toBe(false);
  });
});
