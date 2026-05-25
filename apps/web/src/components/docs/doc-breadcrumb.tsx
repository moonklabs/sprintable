'use client';

import { useCallback } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buildDocPath } from './lib/doc-path';
import type { Doc } from '@/app/(authenticated)/docs/docs-context';

interface DocBreadcrumbProps {
  currentDocId: string;
  tree: Doc[];
  onExpandFolder: (id: string) => void;
  ariaLabel: string;
}

export function DocBreadcrumb({ currentDocId, tree, onExpandFolder, ariaLabel }: DocBreadcrumbProps) {
  const path = buildDocPath(currentDocId, tree);

  const handleSegmentClick = useCallback((doc: Doc, isCurrent: boolean) => {
    if (isCurrent) return;
    const ancestors = buildDocPath(doc.id, tree);
    for (const ancestor of ancestors) {
      if (ancestor.is_folder) onExpandFolder(ancestor.id);
    }
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-doc-id="${doc.id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, [onExpandFolder, tree]);

  if (path.length <= 1) return null;

  return (
    <nav aria-label={ariaLabel} className="flex min-w-0 items-center gap-0.5 overflow-x-auto pb-0.5 text-[11px] text-muted-foreground">
      {path.map((doc, idx) => {
        const isCurrent = idx === path.length - 1;
        return (
          <span key={doc.id} className="flex shrink-0 items-center gap-0.5">
            {idx > 0 && <ChevronRight className="size-3 shrink-0 opacity-50" />}
            <button
              type="button"
              onClick={() => handleSegmentClick(doc, isCurrent)}
              disabled={isCurrent}
              className={cn(
                'max-w-[160px] truncate rounded px-1 py-0.5 transition-colors',
                isCurrent
                  ? 'cursor-default text-foreground/70'
                  : 'hover:bg-muted hover:text-foreground',
              )}
            >
              {doc.icon ? `${doc.icon} ` : ''}{doc.title}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
