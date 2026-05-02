import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { getServerSession } from '@/lib/db/server';
import { getOssUserContext } from '@/lib/auth-helpers';
import { DashboardShell } from '../dashboard/dashboard-shell';
import { fastapiCall } from '@sprintable/storage-api';

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
  if (isOssMode()) {
    const { me, memberships } = await getOssUserContext();
    return (
      <DashboardShell
        currentTeamMemberId={me?.id}
        orgId={me?.org_id}
        projectId={me?.project_id}
        projectName={me?.project_name}
        projectMemberships={memberships.map((membership) => ({ projectId: membership.project_id, projectName: membership.project_name }))}
      >
        {children}
      </DashboardShell>
    );
  }

  const session = await getServerSession();
  if (!session) redirect('/login');

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const meRes = await fetch(`${fastapiUrl}/api/v2/me`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  }).catch(() => null);

  // 401(인증 만료)만 /login 리다이렉트, 다른 에러(500 등)는 children 렌더링 유지
  if (!meRes || meRes.status === 401) redirect('/login');

  const me = meRes.ok ? (await meRes.json() as MemberContext | null) : null;

  return (
    <DashboardShell
      currentTeamMemberId={me?.id}
      orgId={me?.org_id}
      projectId={me?.project_id}
      projectName={me?.project_name ?? undefined}
      projectMemberships={me ? [{ projectId: me.project_id, projectName: me.project_name }] : []}
    >
      {children}
    </DashboardShell>
  );
}
