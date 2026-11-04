'use client';

import { createContext, useContext, type ReactNode } from 'react';

// story 4832 — «this page is served by the desktop app's own (embedded) server». The web learns it from the server only (`isEmbeddedServer()` reads the process env), so the
// authenticated layout reads it once per request and hands it down here; a client component asks `useEmbeddedServer()` instead of growing a path of its own. Outside the
// provider (a page that is not under the authenticated layout, a test) it is false — the hosted behaviour, unchanged.
const EmbeddedServerContext = createContext(false);

export function EmbeddedServerProvider({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  return <EmbeddedServerContext.Provider value={embedded}>{children}</EmbeddedServerContext.Provider>;
}

export function useEmbeddedServer(): boolean {
  return useContext(EmbeddedServerContext);
}
