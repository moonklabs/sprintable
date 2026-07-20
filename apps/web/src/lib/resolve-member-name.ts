// story #2056: `/api/v2/me`의 name은 TeamMember 행을 못 찾는 경우(org-level grant-only/owner
// 휴먼) User.display_name(계정 핸들)로 폴백한다 — 조직 안의 신원(멤버 레코드)이 아니다.
// `/api/v2/team-members`(org-level, project_id 미지정)는 org_members SSOT를 직접 해소해
// 이 경우에도 올바른 조직 내 이름을 돌려준다(story S:166051f0). id는 두 응답 모두 동일
// canonical 값(TeamMember.id 또는 org_member.id)이라 id 매칭으로 교차조회할 수 있다.
export async function resolveOrgMemberName(
  fastapiUrl: string,
  authHeader: Record<string, string>,
  meId: string | undefined,
  fallbackName: string | undefined,
): Promise<string | undefined> {
  if (!meId) return fallbackName;
  try {
    const res = await fetch(`${fastapiUrl}/api/v2/team-members`, { headers: authHeader, cache: 'no-store' });
    if (!res.ok) return fallbackName;
    const members = (await res.json()) as Array<{ id?: string; name?: string }>;
    const match = members.find((m) => m.id === meId);
    return match?.name ?? fallbackName;
  } catch {
    return fallbackName;
  }
}
