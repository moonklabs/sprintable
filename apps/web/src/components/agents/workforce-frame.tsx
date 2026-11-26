'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AgentManagementTab } from '@/components/agents/agent-management-tab';
import { ListDetailShell } from '@/components/ds/list-detail-shell';
import { TabNav, TabNavLink } from '@/components/ds/tab-nav';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useListDetailWide } from '@/hooks/use-list-detail-wide';
import { useOrgAdmin } from '@/hooks/use-org-admin';

const WORKFORCE = '/organization/workforce';

/** The five views that look at ALL agents (not one): kept at their old addresses, reached from ONE entry (story 5035 · PO 11-26). `ns`/`labelKey` reuse the words the old «팀» strip used. */
export type AllViewKey = 'runs' | 'keys' | 'stats' | 'access' | 'recruit';
export interface AllViewConfig { key: AllViewKey; path: string; ns: 'nav' | 'agents'; labelKey: string; adminOnly?: boolean }
export const ALL_VIEWS: readonly AllViewConfig[] = [
  { key: 'runs', path: `${WORKFORCE}/runs`, ns: 'nav', labelKey: 'workforceRuns' },
  { key: 'keys', path: `${WORKFORCE}/api-keys`, ns: 'nav', labelKey: 'workforceApiKeys' },
  { key: 'stats', path: `${WORKFORCE}?tab=stats`, ns: 'agents', labelKey: 'statsTab' },
  { key: 'access', path: `${WORKFORCE}?tab=access`, ns: 'agents', labelKey: 'accessTab', adminOnly: true },
  { key: 'recruit', path: `${WORKFORCE}?tab=recruit`, ns: 'agents', labelKey: 'recruitTab' },
];

export type WorkforceView = { kind: 'split'; agentId: string | null } | { kind: 'all'; key: AllViewKey };

const ALL_TABS = new Set<string>(['stats', 'access', 'recruit']);

/** The address decides the frame: the list + detail («split») for the agent list and one agent's detail, the «all agents» frame for the views that read every agent. Old addresses keep their meaning (a `?tab=` we do not know reads as the list, as before). */
export function resolveWorkforceView(pathname: string, tab: string | null): WorkforceView {
  if (pathname === `${WORKFORCE}/runs`) return { kind: 'all', key: 'runs' };
  if (pathname === `${WORKFORCE}/api-keys`) return { kind: 'all', key: 'keys' };
  if (pathname === WORKFORCE || pathname === `${WORKFORCE}/`) {
    return tab && ALL_TABS.has(tab) ? { kind: 'all', key: tab as AllViewKey } : { kind: 'split', agentId: null };
  }
  if (pathname.startsWith(`${WORKFORCE}/`)) {
    const rest = pathname.slice(WORKFORCE.length + 1).split('/')[0] ?? '';
    return rest ? { kind: 'split', agentId: decodeURIComponent(rest) } : { kind: 'split', agentId: null };
  }
  return { kind: 'split', agentId: null };
}

/** The «all agents» links as a strip (`active` is the current one, none in the list's own entry). */
function AllViewsNav({ active, testId, children }: { active: AllViewKey | null; testId: string; children?: ReactNode }) {
  const ta = useTranslations('agents');
  const tn = useTranslations('nav');
  const flatHref = useFlatHref();
  const { isAdmin } = useOrgAdmin();
  const views = ALL_VIEWS.filter((v) => !v.adminOnly || isAdmin);
  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      {children}
      <TabNav aria-label={ta('allViewsLabel')} className="min-w-0 flex-1">
        {views.map((v) => (
          <TabNavLink key={v.key} asChild active={v.key === active}>
            <Link href={flatHref(v.path)} data-all-view={v.key}>
              {v.ns === 'agents' ? ta(v.labelKey) : tn(v.labelKey)}
            </Link>
          </TabNavLink>
        ))}
      </TabNav>
    </div>
  );
}

/**
 * story 5035 (C5) — the «에이전트» place as ONE frame: the agent list on the left and the picked agent's detail on the right (one screen on a desktop; the detail rises as a sheet on a phone). The five views that read ALL agents
 * (run history · keys · stats · access matrix · recruit) keep their old addresses and are reached from the one «전체 보기» strip — the old «팀» strip of seven links is gone from this place («사람» stays in members).
 * Bones: the ds `ListDetailShell` (the home's list + detail), `TabNav`. The cells inside the detail are the old ones, moved, not rewritten.
 */
export function WorkforceFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = resolveWorkforceView(pathname, searchParams.get('tab'));
  return view.kind === 'all' ? <AllFrame active={view.key}>{children}</AllFrame> : <SplitFrame agentId={view.agentId}>{children}</SplitFrame>;
}

function AllFrame({ active, children }: { active: AllViewKey; children: ReactNode }) {
  const ta = useTranslations('agents');
  const flatHref = useFlatHref();
  return (
    <>
      <div className="px-4 pt-3" data-testid="workforce-all-views-band">
        <AllViewsNav active={active} testId="workforce-all-views-strip">
          <Link href={flatHref(WORKFORCE)} className="shrink-0 text-ds-small font-medium text-ds-action-text hover:underline" data-testid="workforce-back-to-list">
            {ta('allViewsBack')}
          </Link>
        </AllViewsNav>
      </div>
      {children}
    </>
  );
}

function SplitFrame({ agentId, children }: { agentId: string | null; children: ReactNode }) {
  const ta = useTranslations('agents');
  const router = useRouter();
  const flatHref = useFlatHref();
  const wide = useListDetailWide();
  return (
    <div className="px-4 pt-3" data-testid="workforce-frame">
      <ListDetailShell
        testId="workforce-split"
        columnTestId="workforce-detail-column"
        sheetTestId="workforce-detail-sheet"
        wide={wide}
        list={
          <div className="min-w-0 space-y-2" data-testid="workforce-list-column">
            <AllViewsNav active={null} testId="workforce-all-views-menu" />
            <AgentManagementTab onAddAgent={() => router.push(flatHref(`${WORKFORCE}?tab=recruit`))} />
          </div>
        }
        detail={<div className="focus-inset lg:max-h-[inherit] lg:overflow-y-auto">{children}</div>}
        detailLabel={ta('detailPaneLabel')}
        sheetHeader={ta('detailPaneLabel')}
        sheetLabel={ta('detailSheetLabel')}
        sheetOpen={agentId !== null}
        onSheetOpenChange={(open) => { if (!open) router.push(flatHref(WORKFORCE)); }}
      />
    </div>
  );
}
