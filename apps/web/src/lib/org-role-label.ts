// [SID:4282 · 유나 결정 2026-09-25] 조직 역할(owner/admin/member) → organization 네임스페이스 라벨 키 한 곳.
// 역할 페이지 · 에이전트 관리(역할 칩) · 신뢰 센터(같은 이름 구분 꼬리)가 같은 낱말(소유자 · 관리자 · 구성원)을 쓴다.
// 에이전트 관리는 예전에 이 값을 직무 해석기(trust-utils.resolveRoleLabel: implementation/po/qa…)에 넣어 원문(«member»)이 샜다.
export const ORG_ROLE_LABEL_KEY = {
  owner: 'roleGroupOwner',
  admin: 'roleGroupAdmin',
  member: 'roleGroupMember',
} as const;

export type OrgRole = keyof typeof ORG_ROLE_LABEL_KEY;

/** 기본 직무 키(role_key) → organization 라벨 키. 신뢰 센터의 resolveRoleLabel과 에이전트 role 라벨이 같은 표를 쓴다(story 4912 D8). */
export const DEFAULT_ROLE_LABEL_KEY: Record<string, string> = {
  implementation: 'trustRoleLabelImplementation',
  po: 'trustRoleLabelPo',
  qa: 'trustRoleLabelQa',
  design: 'trustRoleLabelDesign',
  devops: 'trustRoleLabelDevops',
};

/**
 * story 4912 (D8) — 에이전트 role을 글자로 바꾸는 **한 함수**(목록 부제 · 상세 머리 칩이 같은 값을 같은 글자로): owner/admin/member → 소유자/관리자/구성원 · 기본 직무 키(implementation/po/qa/design/devops) → i18n 이름 · 그 밖은 원문 · 빈 값은 null.
 * 예전엔 목록은 orgRoleLabel(조직 역할만 · 직무 키는 원문), 상세는 resolveRoleLabel(직무 키만 · «member»가 원문으로 샘)로 같은 값이 두 글자로 갈렸다.
 * 프로토타입 이름(«constructor» 등)은 Object.hasOwn으로 걸러 원문으로 떨어진다.
 */
export function agentRoleLabel(role: string | null | undefined, t: (key: string) => string): string | null {
  if (typeof role !== 'string' || role === '') return null;
  if (Object.hasOwn(ORG_ROLE_LABEL_KEY, role)) return t(ORG_ROLE_LABEL_KEY[role as OrgRole]);
  if (Object.hasOwn(DEFAULT_ROLE_LABEL_KEY, role)) return t(DEFAULT_ROLE_LABEL_KEY[role]!);
  return role;
}

/** 조직 역할 라벨. 모르는 값만 원문으로 떨어진다(유나 결정) · 빈 값은 null. 프로토타입 이름(«constructor» 등)은 원문 문자열로. */
export function orgRoleLabel(role: string | null | undefined, t: (key: string) => string): string | null {
  if (typeof role !== 'string' || role === '') return null;
  return Object.hasOwn(ORG_ROLE_LABEL_KEY, role) ? t(ORG_ROLE_LABEL_KEY[role as OrgRole]) : role;
}
