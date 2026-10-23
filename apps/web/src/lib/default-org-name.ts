/**
 * The organization name made for a person who is not asked for one (story 4427 · Yuna f6cfda19; shared by story 4715's web first screen
 * and story 4711's app setup — PO 2026-10-16: one place, the first PR in makes it).
 */

/** A display name longer than this is not used in the default (Yuna f6cfda19: «40자 넘으면 «내 조직»»). */
export const DEFAULT_NAME_MAX = 40;

/** The default organization name: «{name}의 조직» from the profile display name, or «내 조직» — never the e-mail's local part. */
export function defaultOrgName(displayName: string | null | undefined, withName: (name: string) => string, fallback: string): string {
  const name = (displayName ?? '').trim();
  return name && name.length <= DEFAULT_NAME_MAX ? withName(name) : fallback;
}
