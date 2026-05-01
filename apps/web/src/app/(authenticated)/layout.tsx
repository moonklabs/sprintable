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

  try {
    const session = await getServerSession();
    if (!session) redirect('/login');

    const me = await fastapiCall<MemberContext | null>('GET', '/api/v2/me', session.access_token).catch(() => null);
    if (!me) redirect('/login');

    return (
      <DashboardShell
        currentTeamMemberId={me.id}
        orgId={me.org_id}
        projectId={me.project_id}
        projectName={me.project_name}
        projectMemberships={[{ projectId: me.project_id, projectName: me.project_name }]}
      >
        {children}
      </DashboardShell>
    );
  } catch {
    redirect('/login');
  }
}
