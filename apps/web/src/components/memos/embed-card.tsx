'use client';

import Link from 'next/link';

export const ENTITY_ICONS: Record<string, string> = {
  story: '📋',
  doc: '📄',
  epic: '🎯',
  task: '✅',
};

const ENTITY_COLORS: Record<string, string> = {
  story: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
  doc: 'border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
  epic: 'border-purple-200 bg-purple-50 text-purple-900 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-100',
  task: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
};

export function getEntityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case 'story': return `/board?story=${entityId}`;
    case 'doc': return `/docs?id=${entityId}`;
    case 'epic': return `/epics/${entityId}`;
    case 'task': return null;
    default: return null;
  }
}

export interface EmbedCardData {
  entity_type: string;
  entity_id: string;
  title: string | null;
  status: string | null;
  position?: number;
}

export function EmbedCard({ entity_type, entity_id, title, status }: EmbedCardData) {
  const icon = ENTITY_ICONS[entity_type] ?? '#';
  const colorClass = ENTITY_COLORS[entity_type] ?? 'border-border bg-muted text-foreground';
  const href = getEntityHref(entity_type, entity_id);
  const label = title ?? entity_id;

  const inner = (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${colorClass}`}>
      <span>{icon}</span>
      <span className="font-medium">{label}</span>
      {status ? (
        <span className="ml-auto rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{status}</span>
      ) : null}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block transition-opacity hover:opacity-80">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function EntityChip({
  entityType,
  label,
  href,
}: {
  entityType: string;
  label: string;
  href: string | null;
}) {
  const icon = ENTITY_ICONS[entityType] ?? '#';
  const colorClass = ENTITY_COLORS[entityType] ?? 'border-border bg-muted text-foreground';

  const inner = (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );

  if (href) {
    return (
      <Link href={href} className="inline-flex no-underline transition-opacity hover:opacity-80">
        {inner}
      </Link>
    );
  }
  return inner;
}
