import { ReactNode } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isOssMode } from '@/lib/storage/factory';
import { PageHeader } from '@/components/ui/page-header';
import { SettingsLayoutClient } from './settings-layout-client';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  if (isOssMode()) {
    const { OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
    return (
      <div className="flex min-h-screen flex-col">
        <PageHeader
          title="Settings"
          description="Manage your account, projects, and preferences"
        />
        <SettingsLayoutClient isAdmin={true} currentProjectId={OSS_PROJECT_ID}>
          {children}
        </SettingsLayoutClient>
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Get current project
  const { data: currentProject } = await supabase
    .from('current_project')
    .select('project_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // Check if admin — org_members 직접 조회 (project context 불필요, 다중 프로젝트 안전)
  const { data: orgMember } = await supabase
    .from('org_members')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  const isAdmin = orgMember?.role === 'owner' || orgMember?.role === 'admin';

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        title="Settings"
        description="Manage your account, projects, and preferences"
      />
      <SettingsLayoutClient isAdmin={isAdmin} currentProjectId={currentProject?.project_id}>
        {children}
      </SettingsLayoutClient>
    </div>
  );
}
