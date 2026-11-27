'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';
import { CreateProjectDialog } from '@/components/nav/create-project-dialog';
import { SwitcherMenuContent, useNewProjectOwner, type OrgSwitcherItem } from '@/components/nav/unified-switcher';
import { useUnifiedSwitcher, type ProjectSwitcherItem } from '@/hooks/use-unified-switcher';

// story 5031 (C1 step 5a-2 · PO 11-27): the «조직» and «프로젝트» crumbs of the desktop top bar's path are BUTTONS that open the SAME menu — the project switcher's (organizations → their projects, check on the current one, «새 프로젝트» · «새 조직»).
// ONE state for both: `useUnifiedSwitcher` (the logic the list column's switcher and the phone chip already share) lives in the HOST; each trigger only decides which crumb the menu hangs under. The menu's inside is `SwitcherMenuContent` (unified-switcher.tsx, shared with the list column).
// The host also owns the two dialogs (new project · new organization) and is the PREFERRED owner of the desktop app's «새 프로젝트» door (new-project-owner.ts) — mounted whenever the bar is, so the door opens exactly one dialog even with the column's switcher mounted too.
// Below lg the crumbs are not drawn (the phone keeps ContextSwitcherChip); the host is mounted but idle there.
type Kind = 'org' | 'project';
interface Ctx { s: ReturnType<typeof useUnifiedSwitcher>; anchor: Kind | null; setAnchor: (k: Kind | null) => void }
const SwitcherCtx = createContext<Ctx | null>(null);

export interface TopBarSwitcherHostProps {
  orgs: OrgSwitcherItem[];
  currentOrgId?: string;
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
  children: ReactNode;
}

export function TopBarSwitcherHost({ orgs, currentOrgId, projects, currentProjectId, children }: TopBarSwitcherHostProps) {
  const s = useUnifiedSwitcher({ orgs, currentOrgId, projects, currentProjectId });
  const [anchor, setAnchor] = useState<Kind | null>(null);
  useNewProjectOwner(s.setCreateProjectOpen, 1);
  return (
    <SwitcherCtx.Provider value={{ s, anchor, setAnchor }}>
      {children}
      {/* an organization switch that failed says so (never silent · same line as the list column's switcher) */}
      {/* the line is held to a width (it shrinks and cuts with «…»; the whole text stays in `title`): a long failure text must not eat the path's room or reach the search field and the buttons */}
      {s.switchOrgError ? <p role="alert" title={s.switchOrgError} className="min-w-0 max-w-48 shrink truncate text-ds-small text-ds-failed">{s.switchOrgError}</p> : null}
      <CreateOrganizationDialog open={s.createOrgOpen} onOpenChange={s.setCreateOrgOpen} onCreated={s.handleOrgCreated} />
      <CreateProjectDialog s={s} />
    </SwitcherCtx.Provider>
  );
}

const TRIGGER =
  'inline-flex min-w-0 max-w-full items-center gap-ds-1 rounded-ds-tag text-ds-small text-ds-ink-3 outline-none hover:text-ds-ink data-[popup-open]:text-ds-ink disabled:pointer-events-none ' +
  'focus-visible:text-ds-ink focus-visible:ring-2 focus-visible:ring-ds-action focus-visible:ring-offset-1 focus-visible:ring-offset-ds-background';

/** A crumb that opens the project switcher's menu. Outside a host (a bare test of the path) it is the crumb's plain words. */
export function TopBarSwitcherTrigger({ kind, label }: { kind: Kind; label: string }) {
  const t = useTranslations('nav');
  const ctx = useContext(SwitcherCtx);
  if (!ctx) return <span className="min-w-0 truncate text-ds-small text-ds-ink-3">{label}</span>;
  const { s, anchor, setAnchor } = ctx;
  const open = s.open && anchor === kind;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) { setAnchor(kind); s.setOpen(true); return; }
        if (anchor !== kind) return; // the other crumb's menu closing while this one opens must not close this one
        setAnchor(null);
        s.setOpen(false);
      }}
    >
      {/* the name = the crumb's visible words first (label-in-name), then what the button does */}
      <DropdownMenuTrigger disabled={s.pending} className={TRIGGER} aria-label={`${label}, ${t('topBarSwitcher')}`} data-testid={`top-bar-switcher-${kind}`}>
        <span className="min-w-0 truncate">{label}</span>
        <Icon name="expand_more" size="sm" className={cn('shrink-0')} />
      </DropdownMenuTrigger>
      <SwitcherMenuContent s={s} />
    </DropdownMenu>
  );
}
