import { cookies } from 'next/headers';
import { isOssMode } from '@/lib/storage/factory';

export const CURRENT_PROJECT_COOKIE = 'sprintable_current_project_id';

export interface ProjectMembership {
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
}

export function resolveCurrentProjectMembership(
  memberships: ProjectMembership[],
  currentProjectId: string | null,
): ProjectMembership | null {
  if (currentProjectId) {
    const explicitMembership = memberships.find((membership) => membership.project_id === currentProjectId);
    if (explicitMembership) return explicitMembership;
  }

  if (memberships.length === 1) {
    const [onlyMembership] = memberships;
    return onlyMembership ?? null;
  }

  return null;
}

async function getCurrentProjectIdCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(CURRENT_PROJECT_COOKIE)?.value ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getMyProjectMemberships(supabase: any, user: { id: string }): Promise<ProjectMembership[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, org_id, project_id, projects(id, name)')
    .eq('user_id', user.id)
    .eq('type', 'human')
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error || !data) return [];

  return data
    .map((membership: { id: unknown; org_id: unknown; project_id: unknown; projects: unknown }) => {
      const project = Array.isArray(membership.projects)
        ? membership.projects.find(Boolean)
        : membership.projects;

      return {
        id: membership.id as string,
        org_id: membership.org_id as string,
        project_id: membership.project_id as string,
        project_name: (project as { id: string; name: string } | null)?.name ?? 'Untitled Project',
      };
    })
    .filter((membership: ProjectMembership) => Boolean(membership.project_id));
}

export interface MembershipContext {
  me: {
    id: string;
    org_id: string;
    project_id: string;
    project_name: string;
  } | null;
  memberships: ProjectMembership[];
}

/**
 * 한 번의 호출로 memberships + current team member를 함께 반환.
 * Layout에서 duplicate fetch를 방지한다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getMyMembershipContext(supabase: any, user: { id: string; user_metadata?: Record<string, unknown>; email?: string }): Promise<MembershipContext> {
  const memberships = await getMyProjectMemberships(supabase, user);
  const me = await resolveTeamMemberFromMemberships(supabase, user, memberships);
  return { me, memberships };
}

export async function getOssUserContext(): Promise<MembershipContext> {
  const { OSS_ORG_ID, OSS_PROJECT_ID, OSS_MEMBER_ID } = await import('@sprintable/storage-sqlite');
  const me = {
    id: OSS_MEMBER_ID,
    org_id: OSS_ORG_ID,
    project_id: OSS_PROJECT_ID,
    project_name: 'My Project',
  };
  return {
    me,
    memberships: [{ id: OSS_MEMBER_ID, org_id: OSS_ORG_ID, project_id: OSS_PROJECT_ID, project_name: 'My Project' }],
  };
}

/**
 * 현재 auth user의 team_member를 조회.
 * 없으면 자동 생성 (온보딩에서 누락된 케이스 fallback).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getMyTeamMember(supabase: any, user: { id: string; user_metadata?: Record<string, unknown>; email?: string }) {
  const memberships = await getMyProjectMemberships(supabase, user);
  return resolveTeamMemberFromMemberships(supabase, user, memberships);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveTeamMemberFromMemberships(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  user: { id: string; user_metadata?: Record<string, unknown>; email?: string },
  memberships: ProjectMembership[],
) {
  const currentProjectId = await getCurrentProjectIdCookie();

  if (memberships.length > 0) {
    const selectedMembership = resolveCurrentProjectMembership(memberships, currentProjectId);
    if (!selectedMembership) return null;

    return {
      id: selectedMembership.id,
      org_id: selectedMembership.org_id,
      project_id: selectedMembership.project_id,
      project_name: selectedMembership.project_name,
    };
  }

  const { data: orgMember } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!orgMember) return null;

  const { data: projects, error: projectsError } = await supabase
    .from('projects')
    .select('id, name')
    .eq('org_id', orgMember.org_id)
    .order('created_at', { ascending: true })
    .limit(2);

  if (projectsError) return null;

  if (!projects || projects.length !== 1) return null;

  const [project] = projects;
  if (!project) return null;

  const { checkMemberLimit } = await import('./check-feature');
  const memberCheck = await checkMemberLimit(supabase, orgMember.org_id);
  if (!memberCheck.allowed) return null;

  const { getTranslations } = await import('next-intl/server');
  const tc = await getTranslations('common');
  const name = user.user_metadata?.['name']
    || user.user_metadata?.['full_name']
    || user.email
    || tc('unknown');

  const { data: memberId, error: rpcError } = await supabase
    .rpc('ensure_my_team_member', {
      _org_id: orgMember.org_id,
      _project_id: project.id,
      _name: name,
    });

  if (rpcError || !memberId) return null;

  return {
    id: memberId as string,
    org_id: orgMember.org_id as string,
    project_id: project.id as string,
    project_name: project.name as string,
  };
}

/**
 * Dual auth: OSS (SQLite) → SaaS API Key → SaaS OAuth 순으로 인증
 *
 * supabase 의존성 없음 — SaaS OAuth는 saas-auth.ts hook으로 위임
 */
export async function getAuthContext(
  request: Request
): Promise<{
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
  type?: 'human' | 'agent';
  scope?: string[];
  rateLimitExceeded?: boolean;
  rateLimitRemaining?: number;
  rateLimitResetAt?: number;
} | null> {
  // 1. OSS_MODE — Supabase 없이 SQLite 기반 인증
  if (isOssMode()) {
    const { OSS_ORG_ID, OSS_PROJECT_ID, OSS_MEMBER_ID, getDb } = await import('@sprintable/storage-sqlite');

    const authHeader = request.headers.get('Authorization');
    const xApiKey = request.headers.get('x-api-key');
    const rawApiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (xApiKey ?? null);

    if (rawApiKey) {
      const { hashApiKey } = await import('./auth-api-key');
      const db = getDb();
      const keyHash = hashApiKey(rawApiKey);
      const now = new Date().toISOString();

      const keyRow = db.prepare(
        'SELECT id, team_member_id FROM agent_api_keys WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1'
      ).get(keyHash, now) as { id: string; team_member_id: string } | null;

      if (keyRow) {
        const member = db.prepare(
          'SELECT id, org_id, project_id, type FROM team_members WHERE id = ? AND is_active = 1 LIMIT 1'
        ).get(keyRow.team_member_id) as { id: string; org_id: string; project_id: string; type: string } | null;

        if (member) {
          db.prepare('UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?').run(now, keyRow.id);
          return {
            id: member.id,
            org_id: member.org_id,
            project_id: member.project_id,
            project_name: 'My Project',
            type: member.type as 'human' | 'agent',
          };
        }
      }
    }

    return {
      id: OSS_MEMBER_ID,
      org_id: OSS_ORG_ID,
      project_id: OSS_PROJECT_ID,
      project_name: 'My Project',
      type: 'human',
    };
  }

  // 2. API Key 인증 시도 (SaaS 전용, admin client dynamic import)
  const authHeader = request.headers.get('Authorization');
  const xApiKey = request.headers.get('x-api-key');
  const rawApiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (xApiKey ?? null);
  if (rawApiKey) {
    const { getTeamMemberFromApiKey } = await import('./auth-api-key');
    const { createSupabaseAdminClient } = await import('./supabase/admin');
    const adminClient = await createSupabaseAdminClient();
    const endpoint = new URL(request.url).pathname;
    const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
    const apiKeyMember = await getTeamMemberFromApiKey(adminClient, rawApiKey, { endpoint, ip });

    if (apiKeyMember) {
      const { checkRateLimit } = await import('./rate-limiter');
      const { allowed, remaining, resetAt } = checkRateLimit(apiKeyMember.id);

      return {
        id: apiKeyMember.id,
        org_id: apiKeyMember.org_id,
        project_id: apiKeyMember.project_id,
        project_name: '',
        type: apiKeyMember.type,
        scope: apiKeyMember.scope,
        rateLimitExceeded: !allowed,
        rateLimitRemaining: remaining,
        rateLimitResetAt: resetAt,
      };
    }
  }

  // 3. SaaS OAuth 세션 인증 — saas-auth.ts hook으로 위임 (SaaS overlay에서 실제 구현)
  const { getSaasOAuthContext } = await import('./supabase/saas-auth');
  const oauthMember = await getSaasOAuthContext(request);
  if (!oauthMember) return null;

  return {
    ...oauthMember,
    type: 'human',
  };
}
