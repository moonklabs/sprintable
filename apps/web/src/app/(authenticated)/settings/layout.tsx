import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { isOssMode } from '@/lib/storage/factory';
import { SettingsSidebar } from '@/components/settings/settings-sidebar';
import { PageHeader } from '@/components/ui/page-header';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  if (isOssMode()) {
    const { OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
    return (
      <div className="flex min-h-screen flex-col">
        <PageHeader
          title="Settings"
          description="Manage your account, projects, and preferences"
        />
        <div className="flex flex-1">
          <SettingsSidebar isAdmin={true} currentProjectId={OSS_PROJECT_ID} />
          <main className="flex-1 p-6">
            {children}
          </main>
        </div>
      </div>
    );
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Check if admin
  const { data: orgMember } = await supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', user.id)
    .single();

  const isAdmin = orgMember?.role === 'owner' || orgMember?.role === 'admin';

  // Get current project
  const { data: currentProject } = await supabase
    .from('current_project')
    .select('project_id')
    .eq('user_id', user.id)
    .maybeSingle();

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        title="Settings"
        description="Manage your account, projects, and preferences"
      />
      <div className="flex flex-1">
        <SettingsSidebar isAdmin={isAdmin} currentProjectId={currentProject?.project_id} />
        <main className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
