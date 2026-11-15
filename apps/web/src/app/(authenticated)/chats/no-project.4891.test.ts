// story 4891 (Kadir's note on PR 5490: the test went around the loading states) — isNoProjectAtAll through every state the shell and the layout give. A mutant that dropped any one condition
// passed before. `projectMembershipsFailed` is new, and ONLY the Recruit tab tells it apart (`projectsUnknownBecauseFailed`): the chats surfaces (list · «새 대화» · compose address) keep reading a failed
// request as before — widening `isNoProjectAtAll` moved a gap into each of them (codex, two rounds on PR D), so it is pinned here as NOT part of that rule.
import { describe, expect, it } from 'vitest';
import { isNoProjectAtAll, projectsUnknownBecauseFailed } from './no-project';

const none = { projectId: null as string | null, projectMemberships: [] as unknown[], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false };

describe('isNoProjectAtAll (story 4891)', () => {
  it('true only when nothing is picked, nothing is resolving, and the list is empty', () => {
    expect(isNoProjectAtAll(none)).toBe(true);
  });
  it('each other state is not «none»: a picked project · the address\'s project resolving · the organization of the address not yet the token\'s · projects that exist', () => {
    expect(isNoProjectAtAll({ ...none, projectId: 'p1' })).toBe(false);
    expect(isNoProjectAtAll({ ...none, projectPathUnresolved: true })).toBe(false);
    expect(isNoProjectAtAll({ ...none, orgSyncPending: true })).toBe(false);
    expect(isNoProjectAtAll({ ...none, projectMemberships: [{ projectId: 'p1' }] })).toBe(false);
  });
  it('⭐a failed projects request is NOT part of this rule (the chats surfaces behave as before) — the Recruit tab alone uses projectsUnknownBecauseFailed', () => {
    const failed = { ...none, projectMembershipsFailed: true }; // (a variable, not a literal: the rule's own type does not name the flag — that is the point)
    expect(isNoProjectAtAll(failed)).toBe(true);
  });
  it('the optional flags may be absent (the default context never sets them)', () => {
    expect(isNoProjectAtAll({ projectMemberships: [] })).toBe(true);
  });
});

describe('projectsUnknownBecauseFailed (story 4891, codex on PR D)', () => {
  it('true only when the projects request failed AND nothing names a project (no picked project, no membership)', () => {
    expect(projectsUnknownBecauseFailed({ ...none, projectMembershipsFailed: true })).toBe(true);
  });
  it('⭐not when a project is picked or memberships exist (a failed request does not hide what the shell already knows) · not when nothing failed', () => {
    expect(projectsUnknownBecauseFailed({ ...none, projectMembershipsFailed: true, projectId: 'p1' })).toBe(false);
    expect(projectsUnknownBecauseFailed({ ...none, projectMembershipsFailed: true, projectMemberships: [{ projectId: 'p1' }] })).toBe(false);
    expect(projectsUnknownBecauseFailed(none)).toBe(false);
    expect(projectsUnknownBecauseFailed({ projectMemberships: [] })).toBe(false);
  });
});
