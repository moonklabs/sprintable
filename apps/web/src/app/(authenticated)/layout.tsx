import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyMembershipContext, getOssUserContext } from '@/lib/auth-helpers';
import { DashboardShell } from '../dashboard/dashboard-shell';
import { UpgradeBanner } from '@/components/upgrade-banner';
import { UpgradeModal } from '@/components/upgrade-modal';

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
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) redirect('/login');

    const { me, memberships } = await getMyMembershipContext(supabase, user);

    return (
      <DashboardShell
        currentTeamMemberId={me?.id}
        orgId={me?.org_id}
        projectId={me?.project_id}
        projectName={me?.project_name}
        projectMemberships={memberships.map((membership) => ({ projectId: membership.project_id, projectName: membership.project_name }))}
      >
        <UpgradeBanner />
        <UpgradeModal />
        {children}
      </DashboardShell>
    );
  } catch {
    redirect('/login');
  }
}
