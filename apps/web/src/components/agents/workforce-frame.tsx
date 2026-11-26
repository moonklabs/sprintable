'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AgentManagementTab } from '@/components/agents/agent-management-tab';
import { AgentsTopBarTitle } from '@/components/nav/flat-tab-top-bar';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { TEAM_TABS } from '@/lib/nav-config';
import { ListDetailShell } from '@/components/ds/list-detail-shell';
import { TabNav, TabNavLink } from '@/components/ds/tab-nav';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useListDetailWide } from '@/hooks/use-list-detail-wide';
import { useOrgAdmin } from '@/hooks/use-org-admin';

// The routes come from the old «팀» strip's own data (lib/nav-config TEAM_TABS) — the SAME strings, so an old address cannot drift and this file writes no route literal of its own (the flat-link ratchet counts those).
const pathOf = (id: string): string => TEAM_TABS.find((tab) => tab.id === id)!.path;
const WORKFORCE = pathOf('agents');
const routeOf = (p: string): string => p.split('?')[0]!;

/** The five views that look at ALL agents (not one): kept at their old addresses, reached from ONE entry (story 5035 · PO 11-26). `ns`/`labelKey` are the words the old «팀» strip used. */
export type AllViewKey = 'runs' | 'keys' | 'stats' | 'access' | 'recruit';
export interface AllViewConfig { key: AllViewKey; path: string; ns: 'nav' | 'agents'; labelKey: string; adminOnly?: boolean }
const ALL_VIEW_KEYS: readonly AllViewKey[] = ['runs', 'keys', 'stats', 'access', 'recruit'];
export const ALL_VIEWS: readonly AllViewConfig[] = ALL_VIEW_KEYS.map((key) => {
  const tab = TEAM_TABS.find((t) => t.id === key)!;
  return { key, path: tab.path, ns: tab.ns, labelKey: tab.labelKey, adminOnly: tab.adminOnly };
});

export type WorkforceView = { kind: 'split'; agentId: string | null } | { kind: 'all'; key: AllViewKey };

const ALL_TABS = new Set<string>(['stats', 'access', 'recruit']);
const RUNS_ROUTE = routeOf(pathOf('runs'));
const KEYS_ROUTE = routeOf(pathOf('keys'));

/** The address decides the frame: the list + detail («split») for the agent list and one agent's detail, the «all agents» frame for the views that read every agent. Old addresses keep their meaning (a `?tab=` we do not know reads as the list, as before). */
export function resolveWorkforceView(rawPathname: string, tab: string | null): WorkforceView {
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname; // a trailing slash is the same address (`/runs/` is still the run history, not an agent called «runs»)
  if (pathname === RUNS_ROUTE) return { kind: 'all', key: 'runs' };
  if (pathname === KEYS_ROUTE) return { kind: 'all', key: 'keys' };
  if (pathname === WORKFORCE) {
    return tab && ALL_TABS.has(tab) ? { kind: 'all', key: tab as AllViewKey } : { kind: 'split', agentId: null };
  }
  if (pathname.startsWith(`${WORKFORCE}/`)) {
    const rest = pathname.slice(WORKFORCE.length + 1).split('/')[0] ?? '';
    if (!rest) return { kind: 'split', agentId: null };
    let id = rest;
    try { id = decodeURIComponent(rest); } catch { /* a malformed escape is kept as written — the detail page then says «not found», the frame does not throw */ }
    return { kind: 'split', agentId: id };
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
      <div className="min-w-0 flex-1">
      {/* the five links WRAP onto a second line when they do not fit (story 5035 follow-up · PO's Two-Pass on 390: the strip scrolled sideways and was cut at «접근» with nothing saying there was more) — every link is whole and one press away */}
      <TabNav aria-label={ta('allViewsLabel')} className="flex-wrap overflow-x-visible pr-0 [mask-image:none]">
        {views.map((v) => (
          <TabNavLink key={v.key} asChild active={v.key === active}>
            <Link href={flatHref(v.path)} data-all-view={v.key}>
              {v.ns === 'agents' ? ta(v.labelKey) : tn(v.labelKey)}
            </Link>
          </TabNavLink>
        ))}
      </TabNav>
      </div>
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
  const { isAdmin, loaded } = useOrgAdmin();
  // a non-admin who opens ?tab=access is shown the stats (agents-page-tabs does the same read) — the strip lights the same one
  const lit: AllViewKey = active === 'access' && loaded && !isAdmin ? 'stats' : active;
  return (
    <>
      <div className="px-4 pt-3" data-testid="workforce-all-views-band">
        <AllViewsNav active={lit} testId="workforce-all-views-strip">
          <Link href={flatHref(WORKFORCE)} className="shrink-0 border-r border-ds-line pr-3 text-ds-small font-medium text-ds-action-text hover:underline" data-testid="workforce-back-to-list">
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
      {/* a phone's list draws no detail pane, so none of the children mounts the top bar's title — the frame says it (wide and the sheet both have a child that does) */}
      {!wide && agentId === null ? <TopBarSlot title={<AgentsTopBarTitle />} showContextChip /> : null}
      <ListDetailShell
        testId="workforce-split"
        columnTestId="workforce-detail-column"
        sheetTestId="workforce-detail-sheet"
        wide={wide}
        list={
          <div className="min-w-0 space-y-2" data-testid="workforce-list-column">
            <AllViewsNav active={null} testId="workforce-all-views-menu">
              <span className="shrink-0 text-ds-small text-ds-ink-3" data-testid="workforce-all-views-caption">{ta('allViewsCaption')}</span>
            </AllViewsNav>
            <AgentManagementTab compact onAddAgent={() => router.push(flatHref(`${WORKFORCE}?tab=recruit`))} />
          </div>
        }
        detail={<div className="focus-inset lg:max-h-[inherit] lg:overflow-y-auto">{children}</div>}
        detailLabel={ta('detailPaneLabel')}
        sheetHeader={ta('detailPaneLabel')}
        sheetLabel={ta('detailSheetLabel')}
        sheetOpen={agentId !== null}
        onSheetOpenChange={(open) => { if (!open) router.replace(flatHref(WORKFORCE)); }} /* replace, not push: Back after closing must not reopen the sheet */
      />
    </div>
  );
}
