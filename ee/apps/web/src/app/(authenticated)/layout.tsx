import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyMembershipContext } from '@/lib/auth-helpers';
import { isEEEnabled } from '@/lib/ee-enabled';
import { DashboardShell } from '../dashboard/dashboard-shell';
import { UpgradeBanner } from '@/components/upgrade-banner';
import { UpgradeModal } from '@/components/upgrade-modal';

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) redirect('/login');

    const { me, memberships } = await getMyMembershipContext(supabase, user);
    const eeEnabled = isEEEnabled();

    return (
      <DashboardShell
        currentTeamMemberId={me?.id}
        orgId={me?.org_id}
        projectId={me?.project_id}
        projectName={me?.project_name}
        projectMemberships={memberships.map((membership) => ({ projectId: membership.project_id, projectName: membership.project_name }))}
      >
        {eeEnabled && <UpgradeBanner />}
        {eeEnabled && <UpgradeModal />}
        {children}
      </DashboardShell>
    );
  } catch {
    redirect('/login');
  }
}
