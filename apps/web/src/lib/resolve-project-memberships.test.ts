// story #2885 — sentinel(0-프로젝트 org) 오염 재발방지. 원 재현: SK Leak Test(0-프로젝트
// org)로 전환 후 /me/memberships가 빈 배열인데, 폴백이 me.project_id(=org_id sentinel,
// project_name:null과 짝지어 옴)를 실 멤버십인 양 합성해 accessibleIds→X-Project-Id로
// 전파되고 BE has_project_access가 403 — 「새 프로젝트」 생성이 막혔다.
import { describe, expect, it } from 'vitest';
import { resolveProjectMemberships, resolveServerProjectId } from './resolve-project-memberships';

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

// story #4762 (AC2) — a new organization has no project of its own: `/me` says project_id = the organization id (sentinel, project_name null) or
// nothing, the computer's «start» makes the first project later, and the phone never picked it: the chat list waited («Loading…») 7 minutes in the
// 4758 measurement. The one project the person belongs to is then the only choice. A claim that names a real project (even a stale one) stays.
describe('resolveServerProjectId (story #4762 AC2)', () => {
  const one = [{ projectId: 'p-only', projectName: 'ac5' }];
  const two = [...one, { projectId: 'p-two', projectName: 'second' }];

  it('sentinel claim (project_id = organization id, no name) + exactly one project → that project', () => {
    expect(resolveServerProjectId(one, { project_id: 'org-1', project_name: null })).toBe('p-only');
  });

  it('no claim at all + exactly one project → that project', () => {
    expect(resolveServerProjectId(one, { project_id: null, project_name: null })).toBe('p-only');
  });

  it('a claim that is one of the memberships is kept', () => {
    expect(resolveServerProjectId(two, { project_id: 'p-two', project_name: 'second' })).toBe('p-two');
  });

  it('a stale claim that names a real project the person is not in is NOT replaced (story #2490: no silent jump)', () => {
    expect(resolveServerProjectId(one, { project_id: 'stale-project', project_name: 'Old name' })).toBe('stale-project');
  });

  it('sentinel claim + two projects → left as it was (nothing is picked for the person)', () => {
    expect(resolveServerProjectId(two, { project_id: 'org-1', project_name: null })).toBe('org-1');
  });

  it('sentinel claim + no project → left as it was', () => {
    expect(resolveServerProjectId([], { project_id: 'org-1', project_name: null })).toBe('org-1');
  });

  it('a membership list of another organization than the account\'s own is not «its one project» (tokens and claims can split, story #2545)', () => {
    const foreign = [{ projectId: 'p-b', projectName: 'B project', orgId: 'org-B' }];
    expect(resolveServerProjectId(foreign, { project_id: 'org-A', project_name: null, org_id: 'org-A' })).toBe('org-A');
  });

  it('the same organization (or a list that does not say) still gives its one project', () => {
    expect(resolveServerProjectId([{ projectId: 'p-a', projectName: 'A', orgId: 'org-A' }], { project_id: 'org-A', project_name: null, org_id: 'org-A' })).toBe('p-a');
    expect(resolveServerProjectId([{ projectId: 'p-a', projectName: 'A' }], { project_id: 'org-A', project_name: null, org_id: 'org-A' })).toBe('p-a');
  });

  it('without an account context: the one project is the choice, no project → undefined', () => {
    expect(resolveServerProjectId(one, null)).toBe('p-only');
    expect(resolveServerProjectId([], null)).toBeUndefined();
  });
});
