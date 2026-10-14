/**
 * story 4668 (PO 2026-10-15, dev walk): a signed-in account that already has an organization must not be asked to make one
 * again — the screen came back after a reload (or a re-opened `/onboarding?signup=1`) and the second «조직 만들기» ended in
 * «무료 플랜은 조직을 1개까지». `/api/auth/me` is the one place both onboarding screens already ask who the person is.
 *
 * `org_id` alone is not enough: for a person's session it is the JWT's claim, and an organization deleted from the settings
 * page leaves that claim behind until the next refresh (the settings page then sends them to `/onboarding` to start over).
 * `org_member_id` is read from the database for exactly that organization, so «both present» means the person is a live member
 * of it. Anything else (no answer, no organization, a claim with no membership) → null → the organization step as before.
 */
export function existingOrgIdFromMe(
  json: { data?: { org_id?: string | null; org_member_id?: string | null } } | null | undefined,
): string | null {
  const data = json?.data;
  return data?.org_id && data.org_member_id ? data.org_id : null;
}
