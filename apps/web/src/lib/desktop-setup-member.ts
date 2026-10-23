/**
 * story 4721 — the card a signed-in MEMBER (not owner/admin) meets on the Mac app's setup page (Yuna `invited-member-card-1017` §3).
 * What it says is read from what the page already has (the dashboard context's organization list): the organization's name when it is
 * there, and whether the person may make an organization of their own.
 */
import type { OrgSwitcherItem } from '@/hooks/use-unified-switcher';

export interface MemberCardFacts {
  /** The current organization's name; null when it is not in the list (never made up — the card then says «이 조직»). */
  orgName: string | null;
  /** The person may make an organization of their own: where the plan limit holds (EE builds — `check_owned_org_limit` is EE only, so an
   * OSS build has no limit) it counts the organizations a person OWNS (role owner, one on every plan), so one owned organization closes
   * it. A list that could not be read (empty) leaves it open — the dialog's own 402 says «한도» then; a closed button on a guess would be
   * the dead end again. */
  canCreateOwn: boolean;
}

export function memberCardFacts(orgId: string | null | undefined, memberships: readonly OrgSwitcherItem[] | null | undefined, planLimitHolds: boolean): MemberCardFacts {
  const list = memberships ?? [];
  const name = list.find((o) => o.orgId === orgId)?.orgName?.trim();
  return { orgName: name ? name : null, canCreateOwn: !planLimitHolds || !list.some((o) => o.role === 'owner') };
}
