'use client';

import { useMemo } from 'react';
import type { Doc } from '@/app/(authenticated)/docs/docs-context';

export function useTreeFilter(docs: Doc[], query: string) {
  const isSearching = query.trim().length > 0;

  const { visibleIds, matchedIds } = useMemo(() => {
    if (!isSearching) return { visibleIds: new Set<string>(), matchedIds: new Set<string>() };

    const q = query.toLowerCase().trim();
    const matched = new Set<string>();
    const visible = new Set<string>();
    const docMap = new Map(docs.map((d) => [d.id, d]));

    for (const doc of docs) {
      if (doc.title.toLowerCase().includes(q)) {
        matched.add(doc.id);
        visible.add(doc.id);
        let parentId = doc.parent_id;
        while (parentId) {
          visible.add(parentId);
          parentId = docMap.get(parentId)?.parent_id ?? null;
        }
      }
    }

    return { visibleIds: visible, matchedIds: matched };
  }, [docs, query, isSearching]);

  return { isSearching, visibleIds, matchedIds };
}
