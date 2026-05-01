import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { getServerSession } from '@/lib/supabase/server';
import { getOssUserContext } from '@/lib/auth-helpers';
import { DashboardShell } from '../dashboard/dashboard-shell';

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

    // SaaS: delegate membership context to saas overlay
    const { getSaasMembershipContext } = await import('@/lib/supabase/saas-auth');
    const { me, memberships } = await getSaasMembershipContext(undefined, { id: session.user_id });

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
  } catch {
    redirect('/login');
  }
}
