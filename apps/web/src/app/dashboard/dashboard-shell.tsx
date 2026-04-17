'use client';

import { createContext, useContext } from 'react';
import { RealtimeProvider } from '@/components/realtime-provider';
import { OperatorShell } from '@/components/nav/operator-shell';

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

export function DashboardShell({ currentTeamMemberId, orgId, projectId, projectName, projectMemberships, children }: DashboardShellProps) {
  return (
    <DashboardCtx.Provider value={{ currentTeamMemberId, orgId, projectId, projectName, projectMemberships }}>
      <RealtimeProvider currentTeamMemberId={currentTeamMemberId}>
        <OperatorShell
          currentTeamMemberId={currentTeamMemberId}
          projectId={projectId}
          projectName={projectName}
          projectMemberships={projectMemberships}
        >
          {children}
        </OperatorShell>
      </RealtimeProvider>
    </DashboardCtx.Provider>
  );
}
