// story #2885 — sentinel(0-프로젝트 org) 오염 재발방지. 원 재현: SK Leak Test(0-프로젝트
// org)로 전환 후 /me/memberships가 빈 배열인데, 폴백이 me.project_id(=org_id sentinel,
// project_name:null과 짝지어 옴)를 실 멤버십인 양 합성해 accessibleIds→X-Project-Id로
// 전파되고 BE has_project_access가 403 — 「새 프로젝트」 생성이 막혔다.
import { describe, expect, it } from 'vitest';
import { resolveProjectMemberships } from './resolve-project-memberships';

describe('resolveProjectMemberships (story #2885)', () => {
  it('memberships가 비어있지 않으면 그대로 반환한다', () => {
    const memberships = [{ projectId: 'p1', projectName: '프로젝트1' }];
    expect(resolveProjectMemberships(memberships, { project_id: 'other', project_name: '다른' })).toBe(memberships);
  });

  it('0-프로젝트 org sentinel(project_name:null)은 합성하지 않는다 — 회귀가드', () => {
    const result = resolveProjectMemberships([], { project_id: 'org-id-as-sentinel', project_name: null });
    expect(result).toEqual([]);
  });

  it('memberships fetch 실패했지만 실 현재 프로젝트가 있으면(project_name 존재) 합성한다', () => {
    const result = resolveProjectMemberships([], { project_id: 'real-project-id', project_name: '진짜 프로젝트' });
    expect(result).toEqual([{ projectId: 'real-project-id', projectName: '진짜 프로젝트' }]);
  });

  it('me가 null이면 빈 배열', () => {
    expect(resolveProjectMemberships([], null)).toEqual([]);
  });

  it('project_id는 있는데 project_name이 빈 문자열이어도 합성하지 않는다(falsy 가드)', () => {
    const result = resolveProjectMemberships([], { project_id: 'x', project_name: '' });
    expect(result).toEqual([]);
  });

  it('project_name은 있는데 project_id가 없으면 합성하지 않는다', () => {
    const result = resolveProjectMemberships([], { project_id: null, project_name: '이름만 있음' });
    expect(result).toEqual([]);
  });
});
