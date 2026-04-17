import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyMembershipContext } from '@/lib/auth-helpers';
import { DashboardShell } from './dashboard-shell';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      redirect('/login');
    }

    const { me, memberships } = await getMyMembershipContext(supabase, user);

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
