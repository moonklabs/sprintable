import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyMembershipContext } from '@/lib/auth-helpers';
import { UsageDashboard } from '@/components/settings/usage-dashboard';

export default async function UsagePage() {
  if (isOssMode()) {
    return (
      <div className="p-6 text-muted-foreground">
        Usage tracking is disabled in OSS mode.
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { me, memberships } = await getMyMembershipContext(supabase, user);
  if (!me) redirect('/login');

  const projects = memberships
    .filter((membership) => membership.org_id === me.org_id)
    .map((membership) => ({
      id: membership.project_id,
      name: membership.project_name,
    }));

  return (
    <UsageDashboard
      orgId={me.org_id}
      currentProjectId={me.project_id}
      projects={projects}
      defaultMonth={new Date().toISOString().slice(0, 7)}
    />
  );
}
