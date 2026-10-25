// story #4763 (H6) — where a person goes after deleting their organization from the settings page, and how the onboarding reads it: the onboarding no longer makes a
// same-named organization behind their back; it says what happened and makes the new one on their press. One place for the address so the two ends cannot drift.
export const ORG_DELETED_LANDING = '/onboarding?after=org-deleted';

/** The onboarding page's `after` query value → whether the person came from deleting their organization. */
export function afterOrgDeleted(after: string | undefined): boolean {
  return after === 'org-deleted';
}
