'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ds/icon';
import { DEPTH1_ITEMS } from '@/lib/nav-depth1';
import { leadingCrumbs, nodeText, placeFirstPath, type PathCrumb } from '@/lib/top-bar-path';
import { withProjectParam } from '@/lib/with-project-param';

// story 5031 (C1 step 5a · PO 11-27): the crumbs BEFORE the screen's own title in the desktop top bar's left zone. The rule lives in lib/top-bar-path.ts (org · project-or-place · title); the title itself is the bar's own title slot, drawn by top-bar.tsx right after this.
// Drawn from lg up only (a phone keeps its chip + title). Each crumb with a destination is a link: the organization → 홈, the place → its first screen. The project is a plain name (the switcher is the icon bar's account).
const CRUMB = 'min-w-0 truncate rounded-ds-tag text-ds-small text-ds-ink-3';
const CRUMB_LINK = `${CRUMB} hover:text-ds-ink focus-visible:text-ds-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background`;

export interface TopBarPathProps {
  orgId?: string;
  orgMemberships: ReadonlyArray<{ orgId: string; orgName: string }>;
  projectId?: string;
  projectMemberships: ReadonlyArray<{ projectId: string; projectName: string }>;
  /** the screen's own title (the top bar's slot) — only its text is read, to not say the place's name twice */
  title: ReactNode;
}

/** The crumbs before the title for the page the bar is on (empty when none is known). */
export function useTopBarCrumbs({ orgId, orgMemberships, projectId, projectMemberships, title }: TopBarPathProps): PathCrumb[] {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  return leadingCrumbs({
    pathname,
    orgName: orgMemberships.find((o) => o.orgId === orgId)?.orgName,
    projectName: projectMemberships.find((p) => p.projectId === projectId)?.projectName,
    placeName: (place) => t(DEPTH1_ITEMS.find((d) => d.id === place)!.labelKey),
    placeHref: (place) => withProjectParam(placeFirstPath(place), projectId),
    titleText: nodeText(title),
  });
}

export function TopBarPath({ crumbs }: { crumbs: readonly PathCrumb[] }) {
  const t = useTranslations('nav');
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={t('topBarPath')} data-testid="top-bar-path" className="hidden min-w-0 lg:block">
      <ol className="flex min-w-0 items-center gap-ds-2">
        {crumbs.map((crumb, i) => (
          <li key={crumb.key} data-crumb={crumb.key} className="flex min-w-0 items-center gap-ds-2">
            {i > 0 ? <Icon name="chevron_right" size={16} className="text-ds-ink-3" /> : null}
            {crumb.href ? <Link href={crumb.href} className={CRUMB_LINK}>{crumb.label}</Link> : <span className={CRUMB}>{crumb.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
