import { redirect } from 'next/navigation';
;
import { getServerSession } from '@/lib/db/server';
import { DashboardShell } from './dashboard-shell';
import { fastapiCall } from '@sprintable/storage-api';

interface MemberContext {
  id: string;
  org_id: string;
  project_id: string;
  project_name: string;
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
