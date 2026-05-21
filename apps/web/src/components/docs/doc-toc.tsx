'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { List, X } from 'lucide-react';
import type { DocHeading } from './doc-heading-utils';
import { cn } from '@/lib/utils';

interface DocTocProps {
  headings: DocHeading[];
  onHeadingClick: (id: string) => void;
  className?: string;
}

export function DocToc({ headings, onHeadingClick, className }: DocTocProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleClick = useCallback((id: string) => {
    onHeadingClick(id);
    setOpen(false);
  }, [onHeadingClick]);

  // AC5: 3개 미만이면 숨김
  if (headings.length < 3) return null;

  return (
    <div ref={panelRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
          open
            ? 'border-[color:var(--operator-primary)]/50 bg-[color:var(--operator-primary)]/10 text-[color:var(--operator-primary-soft)]'
            : 'border-border/60 bg-card text-foreground hover:border-[color:var(--operator-primary)]/50 hover:text-[color:var(--operator-primary-soft)]'
        }`}
        title="목차"
      >
        <List className="size-3.5" />
        <span>목차</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-xs font-semibold text-[color:var(--operator-foreground)]">목차</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-[color:var(--operator-muted)] hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <nav className="max-h-72 overflow-y-auto py-1.5">
            {headings.map((heading) => (
              <button
                key={heading.id}
                type="button"
                onClick={() => handleClick(heading.id)}
                className={`flex w-full items-start px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 ${
                  heading.level === 1
                    ? 'font-semibold text-[color:var(--operator-foreground)]'
                    : heading.level === 2
                      ? 'pl-5 text-[color:var(--operator-foreground)]/80'
                      : 'pl-7 text-[color:var(--operator-muted)]'
                }`}
              >
                <span className="mr-1.5 mt-px flex-shrink-0 text-[color:var(--operator-muted)]">
                  {heading.level === 1 ? '◆' : heading.level === 2 ? '◇' : '·'}
                </span>
                <span className="truncate">{heading.text}</span>
              </button>
            ))}
          </nav>
        </div>
      )}
    </div>
  );
}
