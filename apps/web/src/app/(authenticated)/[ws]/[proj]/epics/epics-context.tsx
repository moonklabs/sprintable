'use client';

import { createContext, useContext } from 'react';

interface EpicsRouteContextType {
  wsSlug: string;
  projSlug: string;
  projectId: string;
  orgId: string;
}

const EpicsRouteContext = createContext<EpicsRouteContextType | null>(null);

export function EpicsRouteProvider({
  wsSlug,
  projSlug,
  projectId,
  orgId,
  children,
}: EpicsRouteContextType & { children: React.ReactNode }) {
  return (
    <EpicsRouteContext.Provider value={{ wsSlug, projSlug, projectId, orgId }}>
      {children}
    </EpicsRouteContext.Provider>
  );
}

export function useEpicsRoute(): EpicsRouteContextType {
  const ctx = useContext(EpicsRouteContext);
  if (!ctx) throw new Error('useEpicsRoute must be used within EpicsRouteProvider');
  return ctx;
}
