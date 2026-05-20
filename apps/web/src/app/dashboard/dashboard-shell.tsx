'use client';

import { createContext, useContext } from 'react';
import { usePathname } from 'next/navigation';
import { RealtimeProvider } from '@/components/realtime-provider';
import { AppSidebar } from '@/components/nav/app-sidebar';
import { TopBar } from '@/components/nav/top-bar';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { RefreshProvider } from '@/contexts/refresh-context';
import type { OrgSwitcherItem } from '@/components/nav/organization-switcher';

export interface DashboardProjectOption {
  projectId: string;
  projectName: string;
}

interface DashboardContext {
  currentTeamMemberId?: string;
  orgId?: string;
  projectId?: string;
  projectName?: string;
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

export function DashboardShell({
  currentTeamMemberId,
  orgId,
  projectId,
  projectName,
  projectMemberships,
  orgMemberships,
  children,
}: DashboardShellProps) {
  const pathname = usePathname();
  const showTopBar = !pathname.startsWith('/settings');

  return (
    <DashboardCtx.Provider value={{ currentTeamMemberId, orgId, projectId, projectName, projectMemberships, orgMemberships }}>
      <RefreshProvider>
      <RealtimeProvider currentTeamMemberId={currentTeamMemberId}>
        <TopBarProvider>
          <SidebarProvider className="h-svh">
            <AppSidebar
              currentTeamMemberId={currentTeamMemberId}
              projectId={projectId}
              projectName={projectName}
              projectMemberships={projectMemberships}
              orgId={orgId}
              orgMemberships={orgMemberships}
            />
            <SidebarInset className="relative flex flex-col overflow-hidden">
              {showTopBar && <TopBar />}
              <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
                {children}
              </div>
            </SidebarInset>
          </SidebarProvider>
        </TopBarProvider>
      </RealtimeProvider>
      </RefreshProvider>
    </DashboardCtx.Provider>
  );
}
