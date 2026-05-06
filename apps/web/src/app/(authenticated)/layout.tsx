import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';
import { DashboardShell } from '../dashboard/dashboard-shell';

interface MemberContext {
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
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

  const [meRes, membershipsRes] = await Promise.all([
    fetch(`${fastapiUrl}/api/v2/me`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
    fetch(`${fastapiUrl}/api/v2/me/memberships`, { headers: authHeader, cache: 'no-store' }).catch(() => null),
  ]);

  // 401(인증 만료)만 /login 리다이렉트, 다른 에러(500 등)는 children 렌더링 유지
  if (!meRes || meRes.status === 401) redirect('/login');

  const me = meRes.ok ? (await meRes.json() as MemberContext | null) : null;
  const memberships: { projectId: string; projectName: string }[] =
    membershipsRes?.ok ? ((await membershipsRes.json()) as { projectId: string; projectName: string }[]) : [];
  const projectMemberships = memberships.length > 0
    ? memberships
    : me ? [{ projectId: me.project_id, projectName: me.project_name }] : [];

  return (
    <DashboardShell
      currentTeamMemberId={me?.id}
      orgId={me?.org_id}
      projectId={me?.project_id}
      projectName={me?.project_name ?? undefined}
      projectMemberships={projectMemberships}
    >
      {children}
    </DashboardShell>
  );
}
