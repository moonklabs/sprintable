'use client';

import { createContext, useContext } from 'react';

interface LoopsRouteContextType {
  wsSlug: string;
  projSlug: string;
  projectId: string;
}

const LoopsRouteContext = createContext<LoopsRouteContextType | null>(null);

export function LoopsRouteProvider({
  wsSlug,
  projSlug,
  projectId,
  children,
}: LoopsRouteContextType & { children: React.ReactNode }) {
  return (
    <LoopsRouteContext.Provider value={{ wsSlug, projSlug, projectId }}>
      {children}
    </LoopsRouteContext.Provider>
  );
}

export function useLoopsRoute(): LoopsRouteContextType {
  const ctx = useContext(LoopsRouteContext);
  if (!ctx) throw new Error('useLoopsRoute must be used within LoopsRouteProvider');
  return ctx;
}
