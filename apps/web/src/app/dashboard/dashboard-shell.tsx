'use client';

import { createContext, useContext, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RealtimeProvider } from '@/components/realtime-provider';
import { AppSidebar } from '@/components/nav/app-sidebar';
import { TopBar } from '@/components/nav/top-bar';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { ContextualPanelLayout, useContextualPanelState } from '@/components/ui/contextual-panel-layout';
import { TeamPresencePanel } from '@/components/presence/team-presence-panel';
import { useTeamPresence } from '@/components/presence/use-team-presence';
import { RefreshProvider } from '@/contexts/refresh-context';
import { TeamPresenceToggleProvider } from '@/components/presence/team-presence-toggle';
import type { OrgSwitcherItem } from '@/components/nav/unified-switcher';

export interface DashboardProjectOption {
  projectId: string;
  projectName: string;
}

interface DashboardContext {
  currentTeamMemberId?: string;
  orgId?: string;
  projectId?: string;
  projectName?: string;
  userName?: string;
  projectMemberships: DashboardProjectOption[];
  orgMemberships: OrgSwitcherItem[];
}

const DashboardCtx = createContext<DashboardContext>({ projectMemberships: [], orgMemberships: [] });

export function useDashboardContext() {
  return useContext(DashboardCtx);
}

interface DashboardShellProps extends DashboardContext {
  children: React.ReactNode;
}

function ScrollShell({ showTopBar, children }: { showTopBar: boolean; children: React.ReactNode }) {
  const { setScrollContainer } = useTopBar();
  const setRef = useCallback((el: HTMLDivElement | null) => {
    setScrollContainer(el);
  }, [setScrollContainer]);
  const t = useTranslations('presence');
  // 2505d27d: 상시 팀 presence 패널 — 2xl=inline right-rail / <2xl=drawer. storageKey로 open 영속.
  const panel = useContextualPanelState({ storageKey: 'team-presence', defaultOpen: true });
  // 폴 상향(단일 폴) — 헤더 토글 working-count 배지가 패널 닫힘 상태서도 갱신돼야 하므로 상시 폴(document.hidden 가드는 hook 내).
  const items = useTeamPresence(true);
  const workingCount = items.filter((i) => i.working).length;

  return (
    <TeamPresenceToggleProvider value={{ toggle: panel.togglePanel, workingCount, open: panel.inlinePanelOpen || panel.drawerOpen }}>
    <SidebarInset className="relative flex flex-col overflow-hidden">
      <div ref={setRef} className="flex flex-1 min-h-0 flex-col overflow-y-auto">
        {showTopBar && <TopBar />}
        <ContextualPanelLayout
          renderPanel={({ mode, closePanel }) => (
            <div className={mode === 'inline' ? '2xl:sticky 2xl:top-0 2xl:h-svh 2xl:p-2' : 'h-full'}>
              <TeamPresencePanel
                items={items}
                onClose={mode === 'inline' ? () => panel.setInlinePanelOpen(false) : closePanel}
              />
            </div>
          )}
          inlinePanelOpen={panel.inlinePanelOpen}
          drawerOpen={panel.drawerOpen}
          onDrawerOpenChange={panel.setDrawerOpen}
          drawerAriaLabel={t('panelTitle')}
          drawerSide="right"
          drawerWidthClassName="w-[min(92vw,24rem)]"
          className="min-h-0 flex-1"
          inlineColumnsClassName="2xl:grid-cols-[minmax(0,1fr)_320px]"
          panelClassName="2xl:col-start-2 2xl:row-start-1"
          contentClassName="flex min-h-0 min-w-0 flex-col 2xl:col-start-1 2xl:row-start-1"
        >
          {children}
        </ContextualPanelLayout>
      </div>
    </SidebarInset>
    </TeamPresenceToggleProvider>
  );
}

export function DashboardShell({
  currentTeamMemberId,
  orgId,
  projectId,
  projectName,
  userName,
  projectMemberships,
  orgMemberships,
  children,
}: DashboardShellProps) {
  const pathname = usePathname();
  const showTopBar = !pathname.startsWith('/settings');

  return (
    <DashboardCtx.Provider value={{ currentTeamMemberId, orgId, projectId, projectName, userName, projectMemberships, orgMemberships }}>
      <RefreshProvider>
      <RealtimeProvider currentTeamMemberId={currentTeamMemberId}>
        <TopBarProvider>
          <SidebarProvider className="h-svh">
            <AppSidebar
              currentTeamMemberId={currentTeamMemberId}
              projectId={projectId}
              projectMemberships={projectMemberships}
              orgId={orgId}
              orgMemberships={orgMemberships}
              userName={userName}
            />
            <ScrollShell showTopBar={showTopBar}>
              {children}
            </ScrollShell>
          </SidebarProvider>
        </TopBarProvider>
      </RealtimeProvider>
      </RefreshProvider>
    </DashboardCtx.Provider>
  );
}
