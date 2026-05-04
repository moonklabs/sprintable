import { cache } from 'react';
import { cookies } from 'next/headers';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type User = any;

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

  // explicit cookie가 없더라도 active membership이 하나뿐이면 그 membership이 current project가 된다.
  if (memberships.length === 1) {
    const [onlyMembership] = memberships;
    return onlyMembership ?? null;
  }

  // 다중 membership에서는 명시적 선택 없이는 current project를 암묵적으로 고르지 않는다.
  return null;
}

async function getCurrentProjectIdCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(CURRENT_PROJECT_COOKIE)?.value ?? null;
}

export const getMyProjectMemberships = cache(async (db: any, user: User): Promise<ProjectMembership[]> => {
  const { data, error } = await db
    .from('team_members')
    .select('id, org_id, project_id, projects(id, name)')
    .eq('user_id', user.id)
    .eq('type', 'human')
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error || !data) return [];

  return data
    .map((membership) => {
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
    .filter((membership) => Boolean(membership.project_id));
});

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
export async function getMyMembershipContext(db: any, user: User): Promise<MembershipContext> {
  const memberships = await getMyProjectMemberships(db, user);
  const me = await resolveTeamMemberFromMemberships(db, user, memberships);
  return { me, memberships };
}

/**
 * 현재 auth user의 team_member를 조회.
 * 없으면 자동 생성 (온보딩에서 누락된 케이스 fallback).
 */
export const getMyTeamMember = cache(async (db: any, user: User) => {
  const memberships = await getMyProjectMemberships(db, user);
  return resolveTeamMemberFromMemberships(db, user, memberships);
});

async function resolveTeamMemberFromMemberships(
  db: any,
  user: User,
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

  // fallback self-heal은 레거시/온보딩 누락 복구용으로만 사용한다.
  // current project cookie는 기존 membership 선택에만 사용하며,
  // membership이 0개인 상태에서는 권한 부여 source로 신뢰하지 않는다.
  const { data: orgMember } = await db
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!orgMember) return null;

  const { data: projects, error: projectsError } = await db
    .from('projects')
    .select('id, name')
    .eq('org_id', orgMember.org_id)
    .order('created_at', { ascending: true })
    .limit(2);

  if (projectsError) return null;

  // 다중 프로젝트 org에서는 명시적 project membership이 없는 사용자를
  // 자동으로 아무 프로젝트에 붙이지 않는다.
  if (!projects || projects.length !== 1) return null;

  const [project] = projects;
  if (!project) return null;

  const { checkMemberLimit } = await import('./check-feature');
  const memberCheck = await checkMemberLimit(db, orgMember.org_id);
  if (!memberCheck.allowed) return null;

  const { getTranslations } = await import('next-intl/server');
  const tc = await getTranslations('common');
  const name = user.user_metadata?.name
    || user.user_metadata?.full_name
    || user.email
    || tc('unknown');

  const { data: memberId, error: rpcError } = await db
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
 * Dual auth: OAuth 또는 API Key로 인증
 *
 * 1. Authorization Bearer 토큰이 있으면 API Key 인증 시도
 * 2. 없으면 OAuth 세션 인증 시도
 * 3. 둘 다 실패하면 null 반환
 *
 * Rate limiting:
 * - 에이전트(API Key): 300 req/min
 * - 사람(OAuth): rate limit 없음
 *
 * @returns team_member context { id, org_id, project_id, project_name, type?, rateLimitExceeded? }
 */
export const getAuthContext = cache(async (
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
} | null> => {
  // 1. API Key 인증 — FastAPI /api/v2/me에 rawApiKey를 Bearer 토큰으로 전달
  // x-api-key 헤더는 Authorization 헤더가 CDN에서 strip될 때를 위한 fallback
  const authHeader = request.headers.get('Authorization');
  const xApiKey = request.headers.get('x-api-key');
  const rawApiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (xApiKey ?? null);
  if (rawApiKey) {
    try {
      const { fastapiCall } = await import('@sprintable/storage-api');
      const apiKeyMember = await fastapiCall<{
        id: string; org_id: string; project_id: string; project_name: string;
        type: 'human' | 'agent'; scope?: string[];
      }>('GET', '/api/v2/me', rawApiKey);

      if (apiKeyMember) {
        const { checkRateLimit } = await import('./rate-limiter');
        const { allowed, remaining, resetAt } = checkRateLimit(apiKeyMember.id);
        return {
          id: apiKeyMember.id,
          org_id: apiKeyMember.org_id,
          project_id: apiKeyMember.project_id,
          project_name: apiKeyMember.project_name ?? '',
          type: apiKeyMember.type,
          scope: apiKeyMember.scope,
          rateLimitExceeded: !allowed,
          rateLimitRemaining: remaining,
          rateLimitResetAt: resetAt,
        };
      }
    } catch {
      // API key 인증 실패 — OAuth 경로로 계속
    }
  }

  // 2. OAuth 세션 — JWT 쿠키 파싱
  const { getServerSession } = await import('./db/server');
  const session = await getServerSession();
  if (!session) return null;

  // FastAPI로 team member 조회
  const { fastapiCall } = await import('@sprintable/storage-api');
  const meData = await fastapiCall<{ id: string; org_id: string; project_id: string; project_name: string } | null>(
    'GET', '/api/v2/me', session.access_token
  ).catch(() => null);
  if (!meData) return null;

  return {
    id: meData.id,
    org_id: meData.org_id,
    project_id: meData.project_id,
    project_name: meData.project_name,
    type: 'human' as const,
  };
});
