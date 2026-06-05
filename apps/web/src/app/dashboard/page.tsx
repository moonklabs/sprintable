import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FileText } from 'lucide-react';
import { getServerSession } from '@/lib/db/server';
import { fastapiCall } from '@sprintable/storage-api';
import { getLocale, getTranslations } from 'next-intl/server';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';
import { formatLocaleDateOnly } from '@/lib/i18n';
import { DashboardActivityTimeline } from '@/components/activity/dashboard-activity-timeline';
import { TrustScoreCard } from '@/components/cage/trust-score-card';

export default async function DashboardPage() {
  const fetchedAt = new Date().toISOString();
  const locale = await getLocale();
  const t = await getTranslations('dashboard');
  const getSprintStatusLabel = (status: string) => {
    if (status === 'active') return t('statusActive');
    return status;
  };

  const session = await getServerSession();
  if (!session) redirect('/login');

  const me = await fastapiCall<{ id: string; org_id: string; project_id: string; project_name: string | null }>(
    'GET', '/api/v2/me', session.access_token,
  ).catch(() => null);
  if (!me) redirect('/login');

  const projectId = me.project_id;
  const teamMemberId = me.id;

  // 0746: 전환한 org에 접근 가능한 프로젝트가 없으면(0-프로젝트 org) 옛 org 데이터 잔존/무한로딩 대신
  // 빈상태를 일급으로 보여준다. (switch-org가 stale current-project 쿠키를 clear → projectId 없음)
  if (!projectId) {
    return (
      <div className="min-h-full p-4 lg:p-6">
        <div className="mx-auto max-w-7xl space-y-5">
          <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
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

  const agentsData = await fastapiCall<Array<{ id: string; name: string | null; is_active: boolean; type: string }>>(
    'GET', '/api/v2/members', session.access_token,
    { query: { project_id: projectId, member_type: 'agent' } },
  ).catch(() => null);
  const hasActiveAgent = (agentsData ?? []).some((a) => a.is_active);
  const activeAgents = (agentsData ?? []).filter((a) => a.is_active);

  interface DashboardData {
    my_stories: Array<{ id: string; title: string; status: string; story_points: number | null }>;
    my_tasks: Array<{ id: string; title: string; status: string }>;
  }

  const dashboardData = await fastapiCall<DashboardData>(
    'GET', '/api/v2/dashboard', session.access_token,
    { query: { member_id: teamMemberId, project_id: projectId } },
  ).catch(() => null);

  const activeSprints: Array<{ id: string; title: string; status: string; start_date: string; end_date: string }> = [];
  const docs: Array<{ id: string; title: string; slug: string }> = [];
  const assignedStories = dashboardData?.my_stories ?? [];

  const activeSprint = activeSprints[0] ?? null;
  const msPerDay = 1000 * 60 * 60 * 24;
  const today = new Date();
  const sprintDay = activeSprint
    ? Math.max(1, Math.ceil((today.getTime() - new Date(activeSprint.start_date).getTime()) / msPerDay))
    : null;
  const sprintTotal = activeSprint
    ? Math.ceil((new Date(activeSprint.end_date).getTime() - new Date(activeSprint.start_date).getTime()) / msPerDay)
    : null;
  const sprintProgress =
    sprintDay !== null && sprintTotal !== null && sprintTotal > 0
      ? Math.min(Math.round((sprintDay / sprintTotal) * 100), 100)
      : null;

  const storyCounts = {
    inProgress: assignedStories.filter((s) => s.status === 'in-progress').length,
    inReview: assignedStories.filter((s) => s.status === 'in-review').length,
    blocked: 0,
    open: assignedStories.filter((s) => s.status !== 'done').length,
  };

  return (
    <div className="min-h-full p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <TopBarSlot
          title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        />

        {/* Hero Strip */}
        <section
          className="relative overflow-hidden rounded-xl border border-brand/20 px-6 py-5"
          style={{ background: 'var(--brand-contrast)' }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
            style={{
              background: 'radial-gradient(ellipse at 78% 50%, var(--brand-soft) 0%, transparent 65%)',
              opacity: 0.55,
            }}
          />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {activeSprint && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-brand">
                    {activeSprint.title} · DAY {sprintDay} / {sprintTotal}
                  </span>
                )}
                <Link href="/settings" className="inline-flex items-center gap-1.5">
                  <TrustScoreCard memberId={teamMemberId} compact />
                </Link>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link href="/board">{t('openBoard')}</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/board?view=new">{t('newStory')}</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/standup">{t('standup')}</Link>
                </Button>
              </div>
            </div>

            {activeAgents.length > 0 && (
              <div className="flex items-center gap-3">
                <div className="flex -space-x-2">
                  {activeAgents.slice(0, 6).map((agent) => (
                    <div
                      key={agent.id}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-background bg-brand/20 text-[11px] font-bold text-brand"
                      title={agent.name ?? agent.type}
                    >
                      {(agent.name ?? agent.type).charAt(0).toUpperCase()}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('agentsActive', { count: activeAgents.length })}</p>
              </div>
            )}
          </div>
        </section>

        {/* Agent connection banner — shown only when no active agents */}
        {!hasActiveAgent && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-950">
            <p className="text-sm text-blue-900 dark:text-blue-100">{t('noAgentBanner')}</p>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="shrink-0 border-blue-300 text-blue-800 hover:bg-blue-100 dark:border-blue-700 dark:text-blue-200 dark:hover:bg-blue-900"
            >
              <Link href="/settings?tab=api-keys">{t('noAgentBannerCta')}</Link>
            </Button>
          </div>
        )}

        {/* KPI 4 cards */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground">{t('projects')}</p>
            <p className="mt-1 text-3xl font-bold tracking-tight text-foreground">1</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('projectsHint')}</p>
          </div>

          {activeSprint ? (
            <div
              className="rounded-xl border border-brand/20 p-4"
              style={{ background: 'var(--brand-contrast)' }}
            >
              <p className="text-xs font-medium text-muted-foreground">{t('sprintCycle')}</p>
              <p className="mt-1 text-3xl font-bold tracking-tight text-brand">
                {sprintDay}
                <span className="text-lg font-medium text-muted-foreground">/{sprintTotal}일</span>
              </p>
              <p className="mt-1.5 truncate text-xs text-muted-foreground">{activeSprint.title}</p>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('activeSprints')}</p>
              <p className="mt-1 text-3xl font-bold tracking-tight text-foreground">0</p>
              <p className="mt-1.5 text-xs text-muted-foreground">{t('activeSprintsHint')}</p>
            </div>
          )}

          <div className="rounded-xl border border-warning-border bg-warning-tint p-4">
            <p className="text-xs font-medium text-muted-foreground">{t('inProgress')}</p>
            <p className="mt-1 text-3xl font-bold tracking-tight text-warning">{storyCounts.inProgress}</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('inProgressStories')}</p>
          </div>

          <Link href="/inbox?tab=gates" className="block rounded-xl border border-info-border bg-info-tint p-4 transition hover:bg-info-tint/70">
            <p className="text-xs font-medium text-muted-foreground">{t('hitlPending')}</p>
            <p className="mt-1 text-3xl font-bold tracking-tight text-info">—</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('hitlPendingDesc')}</p>
          </Link>
        </div>

        {/* Main content grid */}
        <div className="grid gap-4 xl:grid-cols-3">
          {/* Pending Work */}
          <SectionCard className="xl:col-span-2">
            <SectionCardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-foreground">{t('pendingWork')}</div>
                <Button asChild variant="outline" size="sm">
                  <Link href="/board">{t('openBoard')}</Link>
                </Button>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-4">
              {/* Status chips */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div
                  className="rounded-lg border border-brand/20 px-4 py-3"
                  style={{ background: 'var(--brand-contrast)' }}
                >
                  <div className="text-2xl font-bold text-brand">{storyCounts.inProgress}</div>
                  <div className="text-xs text-muted-foreground">{t('inProgress')}</div>
                </div>
                <div className="rounded-lg border border-warning-border bg-warning-tint px-4 py-3">
                  <div className="text-2xl font-bold text-warning">{storyCounts.inReview}</div>
                  <div className="text-xs text-muted-foreground">{t('inReview')}</div>
                </div>
                <div
                  className={`rounded-lg border px-4 py-3 ${
                    storyCounts.blocked > 0
                      ? 'border-destructive-border bg-destructive-tint'
                      : 'border-border bg-muted/30'
                  }`}
                >
                  <div
                    className={`text-2xl font-bold ${
                      storyCounts.blocked > 0 ? 'text-destructive' : 'text-foreground'
                    }`}
                  >
                    {storyCounts.blocked}
                  </div>
                  <div className="text-xs text-muted-foreground">{t('blocked')}</div>
                </div>
                <div className="rounded-lg border border-info-border bg-info-tint px-4 py-3">
                  <div className="text-2xl font-bold text-info">{storyCounts.open}</div>
                  <div className="text-xs text-muted-foreground">{t('openStories')}</div>
                </div>
              </div>

              {/* Assigned Stories */}
              {assignedStories.length > 0 ? (
                <div>
                  <div className="mb-2 text-sm font-medium text-foreground">{t('assignedToMe')}</div>
                  <div className="space-y-1.5">
                    {assignedStories.map((story) => (
                      <div
                        key={story.id}
                        className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2.5 transition hover:bg-muted/40"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2.5">
                          <span
                            className={`size-2 shrink-0 rounded-full ${
                              story.status === 'in-progress'
                                ? 'bg-brand'
                                : story.status === 'in-review'
                                  ? 'bg-warning'
                                  : story.status === 'blocked'
                                    ? 'bg-destructive'
                                    : 'bg-muted-foreground'
                            }`}
                          />
                          <span className="truncate text-sm font-medium text-foreground">{story.title}</span>
                        </div>
                        <StatusBadge status={story.status} label={story.status} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState
                  title={t('noAssignedStories')}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href="/board">{t('viewBoard')}</Link>
                    </Button>
                  }
                />
              )}
              <div className="pt-1">
                <span className="text-xs text-muted-foreground">
                  {new Date(fetchedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준
                </span>
              </div>
            </SectionCardBody>
          </SectionCard>

          {/* Sprint Health */}
          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold text-foreground">{t('sprintHealth')}</div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-3">
              {activeSprints.length > 0 ? (
                activeSprints.map((s) => (
                  <Link
                    key={s.id}
                    href={`/board?sprint_id=${s.id}`}
                    className="block rounded-lg border border-border bg-card p-4 transition hover:bg-muted/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-foreground">{s.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatLocaleDateOnly(s.start_date, locale)} ~ {formatLocaleDateOnly(s.end_date, locale)}
                        </p>
                      </div>
                      <StatusBadge status={s.status} label={getSprintStatusLabel(s.status)} />
                    </div>
                    {s.id === activeSprint?.id && sprintProgress !== null && (
                      <div className="mt-3 space-y-1">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{t('sprintCycleProgress')}</span>
                          <span>{sprintProgress}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-brand transition-all"
                            style={{ width: `${sprintProgress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </Link>
                ))
              ) : (
                <EmptyState
                  title={t('noActiveSprints')}
                  description={t('noActiveSprintsDescription')}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href="/sprints">{t('startSprint')}</Link>
                    </Button>
                  }
                />
              )}
              <div className="pt-1">
                <span className="text-xs text-muted-foreground">
                  {new Date(fetchedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준
                </span>
              </div>
            </SectionCardBody>
          </SectionCard>

          {/* Recent Docs */}
          <SectionCard>
            <SectionCardHeader>
              <div className="text-sm font-semibold text-foreground">{t('recentDocs')}</div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-2">
              {docs.length > 0 ? (
                docs.map((doc) => (
                  <Link
                    key={doc.id}
                    href={`/docs/${doc.slug}`}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition hover:bg-muted/40"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <FileText className="size-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{doc.title}</p>
                      <p className="text-xs text-muted-foreground">/{doc.slug}</p>
                    </div>
                  </Link>
                ))
              ) : (
                <EmptyState
                  title={t('noDocsYet')}
                  description={t('noDocsYetDescription')}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href="/docs">{t('writeDocs')}</Link>
                    </Button>
                  }
                />
              )}
              <div className="pt-1">
                <span className="text-xs text-muted-foreground">
                  {new Date(fetchedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준
                </span>
              </div>
            </SectionCardBody>
          </SectionCard>

          <DashboardActivityTimeline projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
