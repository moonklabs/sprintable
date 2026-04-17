import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeInternalDogfoodSession,
  encodeInternalDogfoodSession,
  getInternalDogfoodActors,
  getInternalDogfoodAllowedTeamMemberIds,
  isInternalDogfoodEnabled,
  resolveInternalDogfoodActor,
} from './internal-dogfood';

describe('internal-dogfood helpers', () => {
  const originalEnabled = process.env.INTERNAL_DOGFOOD_ACCESS_ENABLED;
  const originalSecret = process.env.INTERNAL_DOGFOOD_ACCESS_SECRET;
  const originalTeamMemberIds = process.env.INTERNAL_DOGFOOD_TEAM_MEMBER_IDS;
  const originalMaxAge = process.env.INTERNAL_DOGFOOD_ACCESS_MAX_AGE_SECONDS;
  const originalOrgId = process.env.INTERNAL_DOGFOOD_DEFAULT_ORG_ID;
  const originalProjectId = process.env.INTERNAL_DOGFOOD_DEFAULT_PROJECT_ID;
  const originalProjectName = process.env.INTERNAL_DOGFOOD_DEFAULT_PROJECT_NAME;

  afterEach(() => {
    process.env.INTERNAL_DOGFOOD_ACCESS_ENABLED = originalEnabled;
    process.env.INTERNAL_DOGFOOD_ACCESS_SECRET = originalSecret;
    process.env.INTERNAL_DOGFOOD_TEAM_MEMBER_IDS = originalTeamMemberIds;
    process.env.INTERNAL_DOGFOOD_ACCESS_MAX_AGE_SECONDS = originalMaxAge;
    process.env.INTERNAL_DOGFOOD_DEFAULT_ORG_ID = originalOrgId;
    process.env.INTERNAL_DOGFOOD_DEFAULT_PROJECT_ID = originalProjectId;
    process.env.INTERNAL_DOGFOOD_DEFAULT_PROJECT_NAME = originalProjectName;
  });

  it('parses enable flag and allowlisted team member ids', () => {
    process.env.INTERNAL_DOGFOOD_ACCESS_ENABLED = 'true';
    process.env.INTERNAL_DOGFOOD_TEAM_MEMBER_IDS = 'tm-1, tm-2,, tm-3';
    process.env.INTERNAL_DOGFOOD_DEFAULT_ORG_ID = 'org-1';
    process.env.INTERNAL_DOGFOOD_DEFAULT_PROJECT_ID = 'project-1';
    process.env.INTERNAL_DOGFOOD_DEFAULT_PROJECT_NAME = 'Sprintable';

    expect(isInternalDogfoodEnabled()).toBe(true);
    expect(getInternalDogfoodAllowedTeamMemberIds()).toEqual(['tm-1', 'tm-2', 'tm-3']);
    expect(getInternalDogfoodActors()).toEqual([
      { id: 'tm-1', org_id: 'org-1', project_id: 'project-1', name: 'tm-1', project_name: 'Sprintable' },
      { id: 'tm-2', org_id: 'org-1', project_id: 'project-1', name: 'tm-2', project_name: 'Sprintable' },
      { id: 'tm-3', org_id: 'org-1', project_id: 'project-1', name: 'tm-3', project_name: 'Sprintable' },
    ]);
    expect(resolveInternalDogfoodActor('tm-2')).toEqual({
      id: 'tm-2', org_id: 'org-1', project_id: 'project-1', name: 'tm-2', project_name: 'Sprintable',
    });
  });

  it('round-trips a signed session token', () => {
    process.env.INTERNAL_DOGFOOD_ACCESS_SECRET = 'dogfood-secret';
    process.env.INTERNAL_DOGFOOD_ACCESS_MAX_AGE_SECONDS = '3600';

    const token = encodeInternalDogfoodSession({
      teamMemberId: 'tm-1',
      orgId: 'org-1',
      projectId: 'project-1',
      issuedAt: Math.floor(Date.now() / 1000),
    });

    expect(decodeInternalDogfoodSession(token)).toEqual(expect.objectContaining({
      teamMemberId: 'tm-1',
      orgId: 'org-1',
      projectId: 'project-1',
    }));
  });

  it('rejects tampered or expired session tokens', () => {
    process.env.INTERNAL_DOGFOOD_ACCESS_SECRET = 'dogfood-secret';
    process.env.INTERNAL_DOGFOOD_ACCESS_MAX_AGE_SECONDS = '60';

    const token = encodeInternalDogfoodSession({
      teamMemberId: 'tm-1',
      orgId: 'org-1',
      projectId: 'project-1',
      issuedAt: Math.floor(Date.now() / 1000) - 120,
    });

    expect(decodeInternalDogfoodSession(`${token}oops`)).toBeNull();
    expect(decodeInternalDogfoodSession(token)).toBeNull();
  });
});
