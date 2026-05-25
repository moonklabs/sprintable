'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Clock, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Doc {
  id: string;
  title: string;
  slug: string;
  icon?: string | null;
}

interface RecentsSectionProps {
  recentSlugs: string[];
  docs: Doc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  label: string;
  emptyLabel: string;
}

export function RecentsSection({ recentSlugs, docs, selectedSlug, onSelect, label, emptyLabel }: RecentsSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  const recentDocs = recentSlugs
    .map((slug) => docs.find((d) => d.slug === slug))
    .filter((d): d is Doc => d !== undefined);

  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
        <Clock className="size-3 shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        {recentDocs.length > 0 && (
          <span className="text-[10px] tabular-nums">{recentDocs.length}</span>
        )}
      </button>
      {!collapsed && (
        <div className="px-2 pb-1">
          {recentDocs.length === 0 ? (
            <p className="px-2 py-1 text-[11px] italic text-muted-foreground">{emptyLabel}</p>
          ) : (
            <ul className="space-y-0.5">
              {recentDocs.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(doc.slug)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] transition-colors',
                      selectedSlug === doc.slug
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground/80 hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {doc.icon ? (
                      <span className="shrink-0 text-sm leading-none">{doc.icon}</span>
                    ) : (
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{doc.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
