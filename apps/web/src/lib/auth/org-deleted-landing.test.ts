// story #4763 (H6) — the two ends of «after deleting the organization»: the settings page sends the person to the landing, the onboarding page reads it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_DELETED_LANDING, afterOrgDeleted } from './org-deleted-landing';

describe('[SID:4763 H6] organization deleted → onboarding landing', () => {
  it('what the settings page sends is what the onboarding page reads (and nothing else is read as it)', () => {
    const url = new URL(ORG_DELETED_LANDING, 'http://localhost');
    expect(url.pathname).toBe('/onboarding');
    expect(afterOrgDeleted(url.searchParams.get('after') ?? undefined)).toBe(true);
    for (const other of [undefined, '', 'org', 'Org-Deleted', '1']) expect(afterOrgDeleted(other)).toBe(false);
  });

  it('the settings page goes there when the delete answers ok — the only place that leaves for /onboarding after a delete', () => {
    const page = readFileSync(resolve(__dirname, '../../app/(authenticated)/settings/page.tsx'), 'utf8');
    expect(page).toMatch(/if \(res\.ok\) \{\s*(\/\/[^\n]*\n\s*)*window\.location\.href = ORG_DELETED_LANDING;/);
    expect(page).not.toMatch(/window\.location\.href = '\/onboarding'/);
  });
});
