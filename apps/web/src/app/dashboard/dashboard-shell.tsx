'use client';

import { createContext, useContext, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { RealtimeProvider } from '@/components/realtime-provider';
import { AppSidebar } from '@/components/nav/app-sidebar';
import { TopBar } from '@/components/nav/top-bar';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RefreshProvider } from '@/contexts/refresh-context';
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

  return (
    <SidebarInset className="relative flex flex-col overflow-hidden">
      <div ref={setRef} className="flex flex-1 min-h-0 flex-col overflow-y-auto">
        {showTopBar && <TopBar />}
        {children}
      </div>
    </SidebarInset>
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
