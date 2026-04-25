'use client';

import { createContext, useContext } from 'react';
import { RealtimeProvider } from '@/components/realtime-provider';
import { AppSidebar } from '@/components/nav/app-sidebar';
import { TopBar } from '@/components/nav/top-bar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';

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
}

const DashboardCtx = createContext<DashboardContext>({ projectMemberships: [] });

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
  children,
}: DashboardShellProps) {
  return (
    <DashboardCtx.Provider value={{ currentTeamMemberId, orgId, projectId, projectName, projectMemberships }}>
      <RealtimeProvider currentTeamMemberId={currentTeamMemberId}>
        <SidebarProvider className="h-svh">
          <AppSidebar
            currentTeamMemberId={currentTeamMemberId}
            projectId={projectId}
            projectName={projectName}
            projectMemberships={projectMemberships}
          />
          <SidebarInset className="relative flex flex-col overflow-hidden">
            <TopBar />
            <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
              {children}
            </div>
          </SidebarInset>
        </SidebarProvider>
      </RealtimeProvider>
    </DashboardCtx.Provider>
  );
}
