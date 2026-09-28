// [SID:4282 · 유나 결정 2026-09-25] 조직 역할(owner/admin/member) → organization 네임스페이스 라벨 키 한 곳.
// 역할 페이지 · 에이전트 관리(역할 칩) · 신뢰 센터(같은 이름 구분 꼬리)가 같은 낱말(소유자 · 관리자 · 구성원)을 쓴다.
// 에이전트 관리는 예전에 이 값을 직무 해석기(trust-utils.resolveRoleLabel: implementation/po/qa…)에 넣어 원문(«member»)이 샜다.
export const ORG_ROLE_LABEL_KEY = {
  owner: 'roleGroupOwner',
  admin: 'roleGroupAdmin',
  member: 'roleGroupMember',
} as const;

export type OrgRole = keyof typeof ORG_ROLE_LABEL_KEY;

/** 조직 역할 라벨. 모르는 값만 원문으로 떨어진다(유나 결정) · 빈 값은 null. 프로토타입 이름(«constructor» 등)은 원문 문자열로. */
export function orgRoleLabel(role: string | null | undefined, t: (key: string) => string): string | null {
  if (typeof role !== 'string' || role === '') return null;
  return Object.hasOwn(ORG_ROLE_LABEL_KEY, role) ? t(ORG_ROLE_LABEL_KEY[role as OrgRole]) : role;
}
