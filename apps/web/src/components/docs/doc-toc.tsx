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
            ? 'border-border bg-muted text-foreground'
            : 'border-border/60 bg-card text-foreground hover:border-muted-foreground/40 hover:text-foreground'
        }`}
        title="목차"
      >
        <List className="size-3.5" />
        <span>목차</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-border bg-background">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-xs font-semibold text-foreground">목차</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
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
                    ? 'font-semibold text-foreground'
                    : heading.level === 2
                      ? 'pl-5 text-foreground/80'
                      : 'pl-7 text-muted-foreground'
                }`}
              >
                <span className="mr-1.5 mt-px flex-shrink-0 text-muted-foreground">
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
