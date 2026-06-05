import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';
import { DashboardShell } from '../dashboard/dashboard-shell';

interface MemberContext {
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
  name: string;
}

interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect('/login');

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const authHeader = { Authorization: `Bearer ${session.access_token}` };

  const [meRes, membershipsRes, orgsRes] = await Promise.all([
    fetch(`${fastapiUrl}/api/v2/me`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
    fetch(`${fastapiUrl}/api/v2/me/memberships`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
    fetch(`${fastapiUrl}/api/v2/organizations`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
  ]);

  // 401(인증 만료)만 /login 리다이렉트, 다른 에러(500 등)는 children 렌더링 유지
  if (!meRes || meRes.status === 401) redirect('/login');

  // 🔴 org 없는 유저(신규 OAuth 가입자 등 — team_member 미생성 시 /me 404) → 온보딩으로.
  // auth/callback이 is_new_user 무관 /inbox 리다이렉트하는 결함을 layout에서 OAuth+email/pw 공통 커버
  // (org-less가 깨진 페이지 도달 자체 차단). /onboarding은 (authenticated) 밖이라 루프 없음.
  if (meRes.status === 404) redirect('/onboarding');

  // 0746aab9: /me가 403(org 전환 후 project 접근/인가 실패) 등 비-2xx면, 조용히 null 컨텍스트로
  // 렌더하지 않고 에러 경계(error.tsx)로 넘긴다. 기존 `me = meRes.ok ? ... : null`이 403/500을
  // 삼켜 DashboardShell이 org/project 컨텍스트 없이 깨진 화면을 무에러로 렌더하던 footgun 제거.
  if (!meRes.ok) {
    throw new Error(`Failed to load account context (HTTP ${meRes.status})`);
  }

  const me = (await meRes.json()) as MemberContext | null;
  if (!me?.org_id) redirect('/onboarding');
  const memberships: { projectId: string; projectName: string }[] =
    membershipsRes?.ok ? ((await membershipsRes.json()) as { projectId: string; projectName: string }[]) : [];
  const projectMemberships = memberships.length > 0
    ? memberships
    : me ? [{ projectId: me.project_id, projectName: me.project_name }] : [];

  const rawOrgs: OrgMembership[] = orgsRes?.ok ? ((await orgsRes.json()) as OrgMembership[]) : [];
  const orgMemberships = rawOrgs.map((o) => ({
    orgId: o.id,
    orgName: o.name,
    orgSlug: o.slug,
    role: o.role,
  }));

  return (
    <DashboardShell
      currentTeamMemberId={me?.id}
      orgId={me?.org_id}
      projectId={me?.project_id}
      projectName={me?.project_name ?? undefined}
      userName={me?.name}
      projectMemberships={projectMemberships}
      orgMemberships={orgMemberships}
    >
      {children}
    </DashboardShell>
  );
}
