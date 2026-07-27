'use client';

import { createContext, useContext } from 'react';

interface RetroRouteContextType {
  wsSlug: string;
  projSlug: string;
  projectId: string;
}

const RetroRouteContext = createContext<RetroRouteContextType | null>(null);

export function RetroRouteProvider({
  wsSlug,
  projSlug,
  projectId,
  children,
}: RetroRouteContextType & { children: React.ReactNode }) {
  return (
    <RetroRouteContext.Provider value={{ wsSlug, projSlug, projectId }}>
      {children}
    </RetroRouteContext.Provider>
  );
}

export function useRetroRoute(): RetroRouteContextType {
  const ctx = useContext(RetroRouteContext);
  if (!ctx) throw new Error('useRetroRoute must be used within RetroRouteProvider');
  return ctx;
}
