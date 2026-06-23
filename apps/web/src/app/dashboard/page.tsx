import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';
import { fastapiCall } from '@sprintable/storage-api';
import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';
import { CommandCenter } from '@/components/dashboard/command-center/command-center';

// E-MODERN [Track C] 커맨드 센터로 교체(현 vanity 위젯 제거). 헤더+2구역·canonical 부품·pending_data graceful.
// 데이터는 CommandCenter(client)가 org-scope BE 2엔드포인트로 자체 fetch — 서버 prefetch 불요.
export default async function DashboardPage() {
  const t = await getTranslations('dashboard');

  const session = await getServerSession();
  if (!session) redirect('/login');

  const me = await fastapiCall<{ id: string; org_id: string; project_id: string; project_name: string | null }>(
    'GET', '/api/v2/me', session.access_token,
  ).catch(() => null);
  if (!me) redirect('/login');

  const projectId = me.project_id;

  // 0746: 0-프로젝트 org(전환 후 stale 쿠키 clear)는 빈상태 일급 처리(무한로딩 방지).
  if (!projectId) {
    return (
      <div className="min-h-full p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-5">
          <TopBarSlot title={<h1 className="text-sm font-medium">{t('commandCenter')}</h1>} />
          <EmptyState
            title={t('noProjectTitle')}
            description={t('noProjectDescription')}
            action={
              <Button asChild size="sm">
                <Link href={`/onboarding?step=project&orgId=${me.org_id}`}>{t('noProjectAction')}</Link>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('commandCenter')}</h1>} />
        <CommandCenter projectName={me.project_name} />
      </div>
    </div>
  );
}
