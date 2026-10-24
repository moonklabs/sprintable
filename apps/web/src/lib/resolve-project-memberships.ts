export interface ProjectMembership {
  projectId: string;
  projectName: string;
  projectSlug?: string | null;
  orgId?: string | null;
}

/**
 * story #2885 — `(authenticated)/layout.tsx`가 `/me/memberships` 빈 배열을 받았을 때 쓰는
 * 폴백. 원 용도는 "fetch는 실패했지만 실제 현재 프로젝트는 있는" 케이스지만, 0-프로젝트
 * org(진짜로 멤버십이 0)에서도 무가드로 발동해 BE의 sentinel placeholder(`me.project_id` =
 * org_id 자체, `me.project_name` = null — `get_me.py` 참고)를 실 멤버십인 양 합성했다.
 * 그 합성값이 dashboard-shell의 accessibleIds에 들어가 X-Project-Id로 실려 나가면
 * has_project_access가 (정당하게) 403 — 「새 프로젝트」 생성이 막힌다.
 *
 * sentinel은 항상 project_name:null과 짝지어 온다(실 프로젝트라면 이름이 있다) — 그 신호로
 * 가드한다.
 */
/**
 * story #4762 (AC2) — the project the server hands the shell as «the account's own». A new organization starts with no project: `/me` then
 * says `project_id` = the organization's id (the sentinel above, always with `project_name: null`) or nothing. The project is made later (the
 * computer's «start» makes the first one), and this account's claim does not move — so the shell found no project, and the chat list waited
 * for one forever («Loading…», 4758 measured 7 minutes). When the claim is that sentinel (or empty) and the person belongs to exactly ONE
 * project, that project is the only choice — not a pick made for them. Anything else is left exactly as it was: a claim that names a real
 * project (even a stale one — story #2490 «no silent jump to another project»), two or more projects, none at all.
 */
export function resolveServerProjectId(
  memberships: ProjectMembership[],
  me: { project_id?: string | null; project_name?: string | null; org_id?: string | null } | null,
): string | undefined {
  const claim = me?.project_id ?? undefined;
  const claimIsSentinel = !claim || !me?.project_name; // the sentinel always comes with project_name null (above)
  const sole = memberships.length === 1 ? memberships[0]! : undefined;
  // a membership list of ANOTHER organization than the account's own (memberships follow the token's current org, `/me` follows the claim —
  // story #2545 «the two can split») is not this person's one project here
  const sameOrganization = !sole?.orgId || !me?.org_id || sole.orgId === me.org_id;
  if (claimIsSentinel && sole && sameOrganization) return sole.projectId;
  return claim;
}

export function resolveProjectMemberships(
  memberships: ProjectMembership[],
  me: { project_id?: string | null; project_name?: string | null } | null,
): ProjectMembership[] {
  if (memberships.length > 0) return memberships;
  if (me?.project_id && me?.project_name) {
    return [{ projectId: me.project_id, projectName: me.project_name }];
  }
  return [];
}
