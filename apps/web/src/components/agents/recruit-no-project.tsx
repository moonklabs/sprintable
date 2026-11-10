'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { isNoProjectAtAll } from '@/app/(authenticated)/chats/no-project';

/**
 * story 4891 — the Recruit tab («Add agent») without a project. A new account has an organization and NO project; the tab said «Please select a project.» and there was
 * nothing to select and no way on (measured on dev, web + phone width: a first person's first agent stopped here). Which words and which way on depends on what is really known:
 *  · `failed`    — the request for the person's projects failed: «we couldn't load them» + [Try again] (a failure is not «no project» — the person may have projects);
 *  · `create`    — no project at all and the person can create one (organization admin / owner): the line + a button to Settings › Projects, where project creation already is (no new flow);
 *  · `ask-admin` — no project at all and the person cannot create one (Settings › Projects has no form for them): ask an organization admin — no button to a screen with nothing to do;
 *  · `none`      — no project at all, the person's role not known yet: the line only (no button either way until it is);
 *  · `pick`      — projects exist but none is chosen: the old line (the switcher at the top has them).
 */
export type RecruitNoProjectState = 'failed' | 'create' | 'ask-admin' | 'none' | 'pick';

export function recruitNoProjectState(
  ctx: { projectId?: string | null; projectMemberships: readonly unknown[]; projectPathUnresolved?: boolean; orgSyncPending?: boolean; projectMembershipsFailed?: boolean },
  role: { known: boolean; isAdmin: boolean },
): RecruitNoProjectState {
  if (ctx.projectMembershipsFailed && ctx.projectMemberships.length === 0 && !ctx.projectId) return 'failed';
  if (!isNoProjectAtAll(ctx)) return 'pick';
  if (!role.known) return 'none';
  return role.isAdmin ? 'create' : 'ask-admin';
}

export function RecruitNoProject({ state, createHref, onRetry }: { state: RecruitNoProjectState; createHref: string; onRetry: () => void }) {
  const t = useTranslations('recruiter');
  const line = state === 'failed' ? t('projectsLoadFailed') : state === 'ask-admin' ? t('noProjectAsk') : state === 'create' || state === 'none' ? t('noProjectYet') : t('noProject');
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="recruit-no-project" data-state={state}>
      <p className="break-keep text-sm text-muted-foreground">{line}</p>
      {state === 'create' ? (
        <Button asChild size="sm" data-testid="recruit-create-project">
          <Link href={createHref}>{t('createProject')}</Link>
        </Button>
      ) : null}
      {state === 'failed' ? (
        <Button size="sm" variant="outline" onClick={onRetry} data-testid="recruit-retry-projects">{t('projectsRetry')}</Button>
      ) : null}
    </div>
  );
}
