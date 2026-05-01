// OSS stub — SaaS overlay에서 실제 구현 제공 (@supabase import 있음)
// getAuthContext의 SaaS OAuth 분기를 이 파일로 위임

export interface SaasMember {
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
}

export async function getSaasOAuthContext(_request: Request): Promise<SaasMember | null> {
  return null;
}

export interface SaasMembershipContext {
  me: SaasMember | null;
  memberships: Array<{ id: string; org_id: string; project_id: string; project_name: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSaasMembershipContext(_supabase: any, _user: { id: string }): Promise<SaasMembershipContext> {
  return { me: null, memberships: [] };
}
