import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isOssMode } from '@/lib/storage/factory';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CURRENT_PROJECT_COOKIE, getMyProjectMemberships, getOssUserContext, resolveCurrentProjectMembership } from '@/lib/auth-helpers';
import { getLocale, getTranslations } from 'next-intl/server';
import { LogoutButton } from './logout-button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';
import { OperatorStatCard } from '@/components/ui/operator-stat-card';
import { formatLocaleDateOnly, formatLocaleDateTime } from '@/lib/i18n';
import { WidgetRefreshTime } from '@/components/ui/widget-refresh-time';

export default async function DashboardPage() {
  const fetchedAt = new Date().toISOString();
  const locale = await getLocale();
  const t = await getTranslations('dashboard');
  const shellT = await getTranslations('shell');
  const getSprintStatusLabel = (status: string) => {
    if (status === 'active') return t('statusActive');
    return status;
  };

  if (isOssMode()) {
    const { me, memberships } = await getOssUserContext();
    const projectMemberships = memberships;
    const activeSprints: Array<{ id: string; title: string; status: string; start_date: string; end_date: string }> = [];
    const recentMemos: Array<{ id: string; title: string | null; content: string; created_at: string }> = [];
    const docs: Array<{ id: string; title: string; slug: string }> = [];
    const policyDocuments: Array<{ id: string; title: string; created_at: string }> = [];
    const assignedStories: Array<{ id: string; title: string; status: string }> = [];
    const storyCounts = {
      inProgress: 0,
      inReview: 0,
      blocked: 0,
      open: 0,
    };

    return (
      <div className="min-h-full p-4 md:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />

          <SectionCard className="bg-[radial-gradient(circle_at_top_left,rgba(182,196,255,0.18),transparent_40%),linear-gradient(135deg,rgba(0,218,243,0.08),transparent_42%),color-mix(in_srgb,var(--operator-panel)_78%,transparent)]">
              <SectionCardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('commandCenter')}</div>
                    <div className="text-sm text-[color:var(--operator-muted)]">{t('commandCenterDescription')}</div>
                  </div>
                  <StatusBadge status="active" label={t('statusActive')} />
                </div>
              </SectionCardHeader>
              <SectionCardBody className="grid gap-3 md:grid-cols-3">
                <OperatorStatCard label={t('projects')} value={projectMemberships.length} hint={t('projectsHint')} />
                <OperatorStatCard label={t('activeSprints')} value={0} hint={t('activeSprintsHint')} />
                <OperatorStatCard label={t('openMemos')} value={0} hint={t('openMemosHint')} />
              </SectionCardBody>
          </SectionCard>

          <div className="grid gap-4 xl:grid-cols-3">
            <SectionCard className="xl:col-span-2">
              <SectionCardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('pendingWork')}</div>
                  <Button asChild variant="glass" size="sm">
                    <Link href="/board">{t('openBoard')}</Link>
                  </Button>
                </div>
              </SectionCardHeader>
              <SectionCardBody className="space-y-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                    <div className="text-2xl font-bold text-[color:var(--operator-primary-soft)]">{storyCounts.inProgress}</div>
                    <div className="text-xs text-[color:var(--operator-muted)]">{t('inProgress')}</div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                    <div className="text-2xl font-bold text-[color:var(--operator-tertiary)]">{storyCounts.inReview}</div>
                    <div className="text-xs text-[color:var(--operator-muted)]">{t('inReview')}</div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                    <div className="text-2xl font-bold text-[color:var(--operator-danger)]">{storyCounts.blocked}</div>
                    <div className="text-xs text-[color:var(--operator-muted)]">{t('blocked')}</div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
                    <div className="text-2xl font-bold text-[color:var(--operator-foreground)]">{storyCounts.open}</div>
                    <div className="text-xs text-[color:var(--operator-muted)]">{t('openStories')}</div>
                  </div>
                </div>

                {assignedStories.length > 0 ? (
                  <div>
                    <div className="mb-2 text-sm font-medium text-[color:var(--operator-foreground)]">{t('assignedToMe')}</div>
                    <div className="space-y-2">
                      {assignedStories.map((story) => (
                        <div key={story.id} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/4 px-4 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-[color:var(--operator-foreground)]">{story.title}</div>
                          </div>
                          <StatusBadge status={story.status} label={story.status} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3 text-center">
                    <div className="text-sm text-[color:var(--operator-muted)]">{t('noAssignedStories')}</div>
                  </div>
                )}
              </SectionCardBody>
            </SectionCard>

            <SectionCard>
              <SectionCardHeader><div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('sprintHealth')}</div></SectionCardHeader>
              <SectionCardBody className="space-y-3">
                {(activeSprints ?? []).length ? activeSprints!.map((s) => (
                  <div key={s.id} className="rounded-2xl border border-white/8 bg-white/4 p-3">
                    <div className="font-medium text-[color:var(--operator-foreground)]">{s.title}</div>
                    <div className="mt-1 text-xs text-[color:var(--operator-muted)]">{s.start_date} ~ {s.end_date}</div>
                    <div className="mt-2"><StatusBadge status={s.status} label={getSprintStatusLabel(s.status)} /></div>
                  </div>
                )) : <EmptyState title={t('noActiveSprints')} description={t('noActiveSprintsDescription')} />}
              </SectionCardBody>
            </SectionCard>

            <SectionCard>
              <SectionCardHeader><div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('recentDocs')}</div></SectionCardHeader>
              <SectionCardBody className="space-y-2">
                {(docs ?? []).length ? docs!.map((doc) => (
                  <div key={doc.id} className="rounded-2xl border border-white/8 bg-white/4 px-3 py-2">
                    <div className="font-medium text-[color:var(--operator-foreground)]">{doc.title}</div>
                    <div className="text-xs text-[color:var(--operator-muted)]">/{doc.slug}</div>
                  </div>
                )) : <EmptyState title={t('noDocsYet')} description={t('noDocsYetDescription')} />}
              </SectionCardBody>
            </SectionCard>

            <SectionCard>
              <SectionCardHeader><div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('policyDocs')}</div></SectionCardHeader>
              <SectionCardBody className="space-y-2">
                {(policyDocuments ?? []).length ? policyDocuments!.map((doc) => (
                  <div key={doc.id} className="rounded-2xl border border-white/8 bg-white/4 px-3 py-2">
                    <div className="font-medium text-[color:var(--operator-foreground)]">{doc.title}</div>
                    <div className="text-xs text-[color:var(--operator-muted)]">{doc.created_at}</div>
                  </div>
                )) : <EmptyState title={t('noPolicyDocs')} description={t('noPolicyDocsDescription')} />}
              </SectionCardBody>
            </SectionCard>

            <SectionCard>
              <SectionCardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('unreadMemos')}</div>
                  <Link href="/memos" className="text-sm text-[color:var(--operator-primary-soft)]">{shellT('openMemosCta')}</Link>
                </div>
              </SectionCardHeader>
              <SectionCardBody className="space-y-2">
                {(recentMemos ?? []).length ? recentMemos!.map((memo) => (
                  <div key={memo.id} className="rounded-2xl border border-white/8 bg-white/4 px-3 py-2">
                    <div className="font-medium text-[color:var(--operator-foreground)]">{memo.title ?? memo.content.slice(0, 60)}</div>
                    <div className="text-xs text-[color:var(--operator-muted)]">{memo.created_at}</div>
                  </div>
                )) : <EmptyState title={t('noOpenMemos')} description={t('noOpenMemosDescription')} />}
              </SectionCardBody>
            </SectionCard>
          </div>
        </div>
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1);

  if (!memberships || memberships.length === 0) redirect('/onboarding');

  const orgId = memberships[0]!.org_id as string;
  const { data: org } = await supabase
    .from('organizations')
    .select('name, slug')
    .eq('id', orgId)
    .single();

  const projectMemberships = await getMyProjectMemberships(supabase, user);
  const cookieStore = await cookies();
  const currentProjectId = cookieStore.get(CURRENT_PROJECT_COOKIE)?.value ?? null;
  const currentMembership = resolveCurrentProjectMembership(projectMemberships, currentProjectId);

  if (projectMemberships.length === 0) {
    return (
      <div className="min-h-full p-4 md:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <TopBarSlot
            title={<h1 className="text-sm font-medium">{t('title')}</h1>}
            actions={<LogoutButton />}
          />

          <SectionCard>
            <SectionCardBody>
              <EmptyState title={t('noProjectAccess')} description={t('noProjectAccessDescription')} />
            </SectionCardBody>
          </SectionCard>
        </div>
      </div>
    );
  }

  if (!currentMembership) {
    return (
      <div className="min-h-full p-4 md:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <TopBarSlot
            title={<h1 className="text-sm font-medium">{t('title')}</h1>}
            actions={<LogoutButton />}
          />

          <SectionCard>
            <SectionCardBody>
              <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
            </SectionCardBody>
          </SectionCard>
        </div>
      </div>
    );
  }

  const projectId = currentMembership.project_id;
  const teamMemberId = currentMembership.id;

  const [{ data: activeSprints }, { data: recentMemos }, { data: docs }, { data: policyDocuments }, { data: allStories }, { data: assignedStories }] = await Promise.all([
    supabase.from('sprints').select('id, title, status, start_date, end_date').eq('project_id', projectId).eq('status', 'active').limit(3),
    supabase.from('memos').select('id, title, content, status, created_at').eq('project_id', projectId).eq('status', 'open').order('created_at', { ascending: false }).limit(5),
    supabase.from('docs').select('id, title, slug, updated_at').eq('project_id', projectId).order('updated_at', { ascending: false }).limit(4),
    supabase.from('policy_documents').select('id, title, sprint_id, epic_id, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(4),
    supabase.from('stories').select('id, status').eq('project_id', projectId),
    supabase.from('stories').select('id, title, status').eq('project_id', projectId).eq('assignee_id', teamMemberId).limit(5),
  ]);

  // Calculate story counts by status
  const storyCounts = {
    inProgress: allStories?.filter((s) => s.status === 'in-progress').length ?? 0,
    inReview: allStories?.filter((s) => s.status === 'in-review').length ?? 0,
    blocked: 0, // TODO: Add blocked status when available
    open: allStories?.filter((s) => s.status !== 'done').length ?? 0,
  };

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <TopBarSlot
          title={<h1 className="text-sm font-medium">{t('title')}</h1>}
          actions={
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/memos">{shellT('openMemosCta')}</Link>
              </Button>
              <LogoutButton />
            </div>
          }
        />

        <div className="grid gap-4 md:grid-cols-3">
          <SectionCard className="col-span-full">
            <SectionCardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">{t('commandCenter')}</div>
                  <div className="text-sm text-muted-foreground">{t('commandCenterDescription')}</div>
                </div>
                <StatusBadge status="active" label={t('statusActive')} />
              </div>
            </SectionCardHeader>
            <SectionCardBody className="grid gap-3 md:grid-cols-3">
              <OperatorStatCard label={t('projects')} value={projectMemberships.length} hint={t('projectsHint')} />
              <OperatorStatCard label={t('activeSprints')} value={activeSprints?.length ?? 0} hint={t('activeSprintsHint')} />
              <OperatorStatCard label={t('openMemos')} value={recentMemos?.length ?? 0} hint={t('openMemosHint')} />
            </SectionCardBody>
          </SectionCard>

        <div className="grid gap-4 xl:grid-cols-3">
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
              {/* Story Status Counts */}
              <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:grid-cols-4">
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
                  <div className="text-2xl font-bold text-primary">{storyCounts.inProgress}</div>
                  <div className="text-xs text-muted-foreground">{t('inProgress')}</div>
                </div>
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
                  <div className="text-2xl font-bold text-blue-500">{storyCounts.inReview}</div>
                  <div className="text-xs text-muted-foreground">{t('inReview')}</div>
                </div>
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
                  <div className="text-2xl font-bold text-destructive">{storyCounts.blocked}</div>
                  <div className="text-xs text-muted-foreground">{t('blocked')}</div>
                </div>
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
                  <div className="text-2xl font-bold text-foreground">{storyCounts.open}</div>
                  <div className="text-xs text-muted-foreground">{t('openStories')}</div>
                </div>
              </div>

              {/* Assigned Stories */}
              {assignedStories && assignedStories.length > 0 ? (
                <div>
                  <div className="mb-2 text-sm font-medium text-[color:var(--operator-foreground)]">{t('assignedToMe')}</div>
                  <div className="space-y-2">
                    {assignedStories.map((story) => (
                      <div key={story.id} className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-4 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground">{story.title}</div>
                        </div>
                        <StatusBadge status={story.status} label={story.status} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-center">
                  <div className="text-sm text-muted-foreground">{t('noAssignedStories')}</div>
                </div>
              )}
              <div className="pt-1"><WidgetRefreshTime fetchedAt={fetchedAt} /></div>
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader><div className="text-sm font-semibold text-foreground">{t('sprintHealth')}</div></SectionCardHeader>
            <SectionCardBody className="space-y-3">
              {(activeSprints ?? []).length ? activeSprints!.map((s) => (
                <Link
                  key={s.id}
                  href={`/board?sprint_id=${s.id}`}
                  className="block rounded-md border border-border bg-muted/30 p-3 transition hover:bg-muted"
                >
                  <div className="font-medium text-foreground">{s.title}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{formatLocaleDateOnly(s.start_date, locale)} ~ {formatLocaleDateOnly(s.end_date, locale)}</div>
                  <div className="mt-2"><StatusBadge status={s.status} label={getSprintStatusLabel(s.status)} /></div>
                </Link>
              )) : <EmptyState title={t('noActiveSprints')} description={t('noActiveSprintsDescription')} />}
              <div className="pt-1"><WidgetRefreshTime fetchedAt={fetchedAt} /></div>
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader><div className="text-sm font-semibold text-foreground">{t('recentDocs')}</div></SectionCardHeader>
            <SectionCardBody className="space-y-2">
              {(docs ?? []).length ? docs!.map((doc) => (
                <div key={doc.id} className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <div className="font-medium text-foreground">{doc.title}</div>
                  <div className="text-xs text-muted-foreground">/{doc.slug}</div>
                </div>
              )) : <EmptyState title={t('noDocsYet')} description={t('noDocsYetDescription')} />}
              <div className="pt-1"><WidgetRefreshTime fetchedAt={fetchedAt} /></div>
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader><div className="text-sm font-semibold text-foreground">{t('policyDocs')}</div></SectionCardHeader>
            <SectionCardBody className="space-y-2">
              {(policyDocuments ?? []).length ? policyDocuments!.map((doc) => (
                <div key={doc.id} className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <div className="font-medium text-foreground">{doc.title}</div>
                  <div className="text-xs text-muted-foreground">{formatLocaleDateTime(doc.created_at, locale)}</div>
                </div>
              )) : <EmptyState title={t('noPolicyDocs')} description={t('noPolicyDocsDescription')} />}
              <div className="pt-1"><WidgetRefreshTime fetchedAt={fetchedAt} /></div>
            </SectionCardBody>
          </SectionCard>

          <SectionCard>
            <SectionCardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-foreground">{t('unreadMemos')}</div>
                <Link href="/memos" className="text-sm text-primary">{shellT('openMemosCta')}</Link>
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-2">
              {(recentMemos ?? []).length ? recentMemos!.map((memo) => (
                <div key={memo.id} className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <div className="font-medium text-foreground">{memo.title ?? memo.content.slice(0, 60)}</div>
                  <div className="text-xs text-muted-foreground">{formatLocaleDateTime(memo.created_at, locale)}</div>
                </div>
              )) : <EmptyState title={t('noOpenMemos')} description={t('noOpenMemosDescription')} />}
              <div className="pt-1"><WidgetRefreshTime fetchedAt={fetchedAt} /></div>
            </SectionCardBody>
          </SectionCard>
        </div>
      </div>
    </div>
    </div>
  );
}
