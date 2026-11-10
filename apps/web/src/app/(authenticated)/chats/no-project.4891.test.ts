// story 4891 (Kadir's note on PR 5490: the test went around the loading states) — isNoProjectAtAll through every state the shell and the layout give. A mutant that dropped any one condition
// passed before. `projectMembershipsFailed` is new: a failed projects request leaves the list empty too — the person's projects are then UNKNOWN, not none.
import { describe, expect, it } from 'vitest';
import { isNoProjectAtAll } from './no-project';

const none = { projectId: null as string | null, projectMemberships: [] as unknown[], projectPathUnresolved: false, orgSyncPending: false, projectMembershipsFailed: false };

describe('isNoProjectAtAll (story 4891)', () => {
  it('true only when nothing is picked, nothing is resolving, nothing failed, and the list is empty', () => {
    expect(isNoProjectAtAll(none)).toBe(true);
  });
  it('each other state is not «none»: a picked project · the address\'s project resolving · the organization of the address not yet the token\'s · a failed projects request · projects that exist', () => {
    expect(isNoProjectAtAll({ ...none, projectId: 'p1' })).toBe(false);
    expect(isNoProjectAtAll({ ...none, projectPathUnresolved: true })).toBe(false);
    expect(isNoProjectAtAll({ ...none, orgSyncPending: true })).toBe(false);
    expect(isNoProjectAtAll({ ...none, projectMembershipsFailed: true })).toBe(false);
    expect(isNoProjectAtAll({ ...none, projectMemberships: [{ projectId: 'p1' }] })).toBe(false);
  });
  it('the optional flags may be absent (the default context never sets them)', () => {
    expect(isNoProjectAtAll({ projectMemberships: [] })).toBe(true);
  });
});
