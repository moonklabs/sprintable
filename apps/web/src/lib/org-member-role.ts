/**
 * story #3491(페드루 PO 確定 2026-09-05, 미르코 그라운딩) — FE 게이트를 BE 인가
 * 폭과 맞춘다. 예전엔 `isOwner && !isThisOwner`(owner 전용)로 admin이 역할을 못
 * 바꿨는데, BE(`backend/app/routers/org_members.py::update_org_member`)는 owner
 * 또는 admin 둘 다 통과시킨다(`_require_admin`) — FE만 임의로 더 좁혀져 있었다
 * (git blame 실측: 무관 스토리 E-BOARD-S4에 부수 유입, 의도된 결정 흔적 0).
 *
 * BE가 실제로 거부하는 세 축을 그대로 미러한다(서버가 최종 판정자 — 이 함수는
 * "괜히 눌러보고 403 받는" UX만 줄인다, 보안 경계는 서버 쪽):
 *   ① owner 또는 admin만 ② 대상이 owner면 안 됨(admin은 owner 부여도 못 하므로
 *      owner 행 자체를 손 못 댄다 — owner caller가 다른 owner를 강등하는 것은
 *      서버가 허용하지만, 그 조작은 이 화면의 단순 admin/member 토글 밖이라 이
 *      함수는 관여하지 않는다 — 3화면 모두 owner 행은 항상 읽기전용 Badge) ③
 *      자기 자신이면 안 됨(currentUserId가 아직 안 실렸으면 안전측으로 "모른다"
 *      취급 — 서버가 최종 방어선이라 화면이 지어내지 않는다).
 *
 * 3화면(`organization/members`·`organization/roles`·설정 org-members 탭) 공용 —
 * 컴포넌트 트리가 갈라져 있어 로직만 이 한 곳으로 모은다(PO 確定 "같은 규칙으로").
 */
export function canEditOrgMemberRole(params: {
  currentRole: string;
  currentUserId: string | null | undefined;
  member: { role: string; user_id: string | null | undefined };
}): boolean {
  const { currentRole, currentUserId, member } = params;
  if (currentRole !== 'owner' && currentRole !== 'admin') return false;
  if (member.role === 'owner') return false;
  if (currentUserId != null && member.user_id != null && currentUserId === member.user_id) return false;
  return true;
}
