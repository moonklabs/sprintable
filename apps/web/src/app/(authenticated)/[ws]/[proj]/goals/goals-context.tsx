'use client';

import { createContext, useContext } from 'react';

interface GoalsRouteContextType {
  wsSlug: string;
  projSlug: string;
  projectId: string;
  orgId: string;
}

const EpicsRouteContext = createContext<GoalsRouteContextType | null>(null);

export function GoalsRouteProvider({
  wsSlug,
  projSlug,
  projectId,
  orgId,
  children,
}: GoalsRouteContextType & { children: React.ReactNode }) {
  return (
    <EpicsRouteContext.Provider value={{ wsSlug, projSlug, projectId, orgId }}>
      {children}
    </EpicsRouteContext.Provider>
  );
}

export function useGoalsRoute(): GoalsRouteContextType {
  const ctx = useContext(EpicsRouteContext);
  if (!ctx) throw new Error('useGoalsRoute must be used within GoalsRouteProvider');
  return ctx;
}
