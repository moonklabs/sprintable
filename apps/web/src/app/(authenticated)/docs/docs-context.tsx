'use client';

import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

export interface Doc {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  is_folder?: boolean;
}

export interface DocUpdate {
  id: string;
  title: string;
  updated_at: string;
}

interface DocsLayoutContextType {
  projectId: string | undefined;
  setTree: Dispatch<SetStateAction<Doc[]>>;
  handleNewDoc: () => void;
  fetchTree: () => Promise<void>;
  pendingDocUpdate: DocUpdate | null;
  clearPendingDocUpdate: () => void;
}

export const DocsLayoutContext = createContext<DocsLayoutContextType | null>(null);

export function useDocsLayout(): DocsLayoutContextType {
  const ctx = useContext(DocsLayoutContext);
  if (!ctx) throw new Error('useDocsLayout must be used within DocsLayout');
  return ctx;
}
