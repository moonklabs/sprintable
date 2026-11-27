'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TopBarSwitcherTrigger } from './top-bar-switcher';
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
  /** the screen's own title (the top bar's slot) — its words are read to not say the place's name twice … */
  title: ReactNode;
  /** … from here when the publisher gave them (a title that is a component has no words an element scan can read), else from the element's own text */
  titleText?: string;
}

/** The crumbs before the title for the page the bar is on (empty when none is known). */
export function useTopBarCrumbs({ orgId, orgMemberships, projectId, projectMemberships, title, titleText }: TopBarPathProps): PathCrumb[] {
  const pathname = usePathname() ?? '';
  const t = useTranslations('nav');
  return leadingCrumbs({
    pathname,
    orgName: orgMemberships.find((o) => o.orgId === orgId)?.orgName,
    projectName: projectMemberships.find((p) => p.projectId === projectId)?.projectName,
    placeName: (place) => t(DEPTH1_ITEMS.find((d) => d.id === place)!.labelKey),
    placeHref: (place) => withProjectParam(placeFirstPath(place), projectId),
    titleText: titleText ?? nodeText(title),
  });
}

/**
 * The path as ONE list: the crumbs before the title, then the screen's own title as the last item (`aria-current="page"`). The title keeps its own element (an h1 stays an h1, a span a span) — it is only wrapped in the list item.
 * Below lg the nav and the list are `display: contents`, the leading crumbs are hidden and the title item is the bar's own flex item exactly as the title wrapper was (the phone bar is as before).
 * `stale`: the slot's title was published for another path (the screen has not published for this one yet) — from lg it is kept in the layout but not painted, so the old screen's name is never seen under the new path.
 */
export function TopBarPath({ crumbs, title, stale }: { crumbs: readonly PathCrumb[]; title: ReactNode; stale: boolean }) {
  const t = useTranslations('nav');
  // The roles are written out on purpose: below lg the nav and the list are `display: contents`, and WebKit (VoiceOver) drops the implicit role of an element laid out with `display: contents` — the explicit role keeps the navigation / list / item meaning there.
  // They repeat the implicit roles (the project's lint does not enable jsx-a11y/no-redundant-roles — if it ever does, these lines carry the reason); from lg the elements are ordinary boxes and nothing is announced twice.
  return (
    <nav role="navigation" aria-label={t('topBarPath')} data-testid="top-bar-path" className="contents lg:flex lg:min-w-0 lg:flex-1 lg:items-center">
      <ol role="list" className="contents lg:flex lg:min-w-0 lg:flex-1 lg:items-center lg:gap-ds-2">
        {crumbs.map((crumb, i) => (
          <li key={crumb.key} role="listitem" data-crumb={crumb.key} className="hidden min-w-0 items-center gap-ds-2 lg:flex">
            {i > 0 ? <Icon name="chevron_right" size={16} className="text-ds-ink-3" /> : null}
            {crumb.key === 'place' && crumb.href ? <Link href={crumb.href} className={CRUMB_LINK}>{crumb.label}</Link> : <TopBarSwitcherTrigger kind={crumb.key === 'project' ? 'project' : 'org'} label={crumb.label} />}
          </li>
        ))}
        <li
          role="listitem"
          data-testid="top-bar-title"
          data-stale-title={stale ? '' : undefined}
          aria-current="page"
          className={cn(
            'flex min-w-0 flex-auto items-center gap-2 [&>*]:min-w-0 [&>*]:truncate lg:empty:hidden lg:data-[stale-title]:invisible',
            // the separator before the title is drawn only when a crumb comes before it and the title drew something (a title component that renders nothing leaves the item empty)
            crumbs.length > 0 && "lg:not-empty:before:shrink-0 lg:not-empty:before:text-ds-ink-3 lg:not-empty:before:content-['›']",
          )}
        >
          {title}
        </li>
      </ol>
    </nav>
  );
}
