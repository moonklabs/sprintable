export interface ProjectMembership {
  projectId: string;
  projectName: string;
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
