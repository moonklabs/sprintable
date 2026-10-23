import { describe, expect, it } from 'vitest';
import { memberCardFacts } from './desktop-setup-member';

const org = (orgId: string, orgName: string, role: string) => ({ orgId, orgName, orgSlug: orgId, role });

describe('story 4721 — memberCardFacts', () => {
  it('the current organization\'s name · no owned organization → may make one', () => {
    expect(memberCardFacts('a', [org('a', ' Acme ', 'member')], true)).toEqual({ orgName: 'Acme', canCreateOwn: true });
  });
  it('a name that is not in the list (or empty) is null, never made up', () => {
    expect(memberCardFacts('zz', [org('a', 'Acme', 'member')], true).orgName).toBeNull();
    expect(memberCardFacts('a', [org('a', '  ', 'member')], true).orgName).toBeNull();
    expect(memberCardFacts(null, undefined, true)).toEqual({ orgName: null, canCreateOwn: true });
  });
  it('owning one organization closes it (the plan counts owner rows — one on every plan); admin does not count', () => {
    expect(memberCardFacts('a', [org('a', 'Acme', 'member'), org('b', 'Mine', 'owner')], true).canCreateOwn).toBe(false);
    // a build without the plan limit (OSS: the server only counts it in EE) never closes it
    expect(memberCardFacts('a', [org('a', 'Acme', 'member'), org('b', 'Mine', 'owner')], false).canCreateOwn).toBe(true);
    expect(memberCardFacts('a', [org('a', 'Acme', 'member'), org('b', 'Other', 'admin')], true).canCreateOwn).toBe(true);
  });
});
