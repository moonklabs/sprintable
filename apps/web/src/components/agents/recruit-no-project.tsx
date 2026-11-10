'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * story 4891 — the Recruit tab («Add agent») without a project. A new account has an organization and NO project; the tab said «Please select a project.» and there was
 * nothing to select and no way on (measured on dev, web + phone width: a first person's first agent stopped here). With no project at all the tab now says so and points at the
 * project creation that already exists (Settings › Projects) — no new creation flow. With projects but none chosen, the old line stays (the switcher at the top has them).
 */
export function RecruitNoProject({ noProjectAtAll, createHref }: { noProjectAtAll: boolean; createHref: string }) {
  const t = useTranslations('recruiter');
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="recruit-no-project">
      <p className="break-keep text-sm text-muted-foreground">{noProjectAtAll ? t('noProjectYet') : t('noProject')}</p>
      {noProjectAtAll ? (
        <Button asChild size="sm" data-testid="recruit-create-project">
          <Link href={createHref}>{t('createProject')}</Link>
        </Button>
      ) : null}
    </div>
  );
}
