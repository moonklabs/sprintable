'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, X } from 'lucide-react';

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

const ENTITY_API: Record<string, (id: string) => string> = {
  story: (id) => `/api/stories/${id}`,
  epic: (id) => `/api/epics/${id}`,
  doc: (id) => `/api/docs/${id}`,
};

function EntityDetail({ entityType, detail }: { entityType: string; detail: Record<string, unknown> }) {
  const snippet = (text: unknown) =>
    typeof text === 'string' && text.trim()
      ? text.trim().slice(0, 160) + (text.trim().length > 160 ? '…' : '')
      : null;

  const badge = (label: string) => (
    <span className="rounded border px-1.5 py-0.5 text-[11px] font-medium border-border bg-muted text-muted-foreground">
      {label}
    </span>
  );

  if (entityType === 'story') {
    const d = detail as { status?: string; priority?: string; story_points?: number; description?: string };
    return (
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {d.status && badge(d.status)}
          {d.priority && badge(d.priority)}
          {d.story_points != null && badge(`${d.story_points} SP`)}
        </div>
        {snippet(d.description) && (
          <p className="text-xs text-muted-foreground leading-relaxed">{snippet(d.description)}</p>
        )}
      </div>
    );
  }

  if (entityType === 'epic') {
    const d = detail as { status?: string; priority?: string; objective?: string };
    return (
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {d.status && badge(d.status)}
          {d.priority && badge(d.priority)}
        </div>
        {snippet(d.objective) && (
          <p className="text-xs text-muted-foreground leading-relaxed">{snippet(d.objective)}</p>
        )}
      </div>
    );
  }

  if (entityType === 'doc') {
    const d = detail as { content?: string };
    const preview = snippet(d.content?.replace(/[#*`>]/g, '').replace(/\n+/g, ' '));
    return preview ? (
      <p className="text-xs text-muted-foreground leading-relaxed">{preview}</p>
    ) : null;
  }

  return null;
}

function EntityPreviewModal({
  entityType,
  entityId,
  title,
  status,
  href,
  onClose,
}: {
  entityType: string;
  entityId: string;
  title: string | null;
  status: string | null;
  href: string | null;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(entityType !== 'task');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    const url = ENTITY_API[entityType]?.(entityId);
    if (!url) return;
    fetch(url)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => setDetail((json as { data?: Record<string, unknown> }).data ?? json as Record<string, unknown>))
      .catch(() => { /* fetch 실패 시 fallback만 표시 */ })
      .finally(() => setLoading(false));
  }, [entityType, entityId]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const icon = ENTITY_ICONS[entityType] ?? '#';
  const colorClass = ENTITY_COLORS[entityType] ?? 'border-border bg-muted text-foreground';
  const label = title ?? entityId;

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-popover p-5 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
          aria-label="닫기"
        >
          <X className="h-4 w-4" />
        </button>
        <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${colorClass} mb-3`}>
          <span>{icon}</span>
          <span className="font-medium">{label}</span>
          {status ? (
            <span className="ml-auto rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{status}</span>
          ) : null}
        </div>
        <div className="mb-4 min-h-[40px]">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              불러오는 중…
            </div>
          ) : detail ? (
            <EntityDetail entityType={entityType} detail={detail} />
          ) : entityType === 'task' ? (
            <p className="text-xs text-muted-foreground">이 엔티티는 별도 페이지가 없는.</p>
          ) : null}
        </div>
        {href ? (
          <Link
            href={href}
            onClick={onClose}
            className="flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            전체 보기
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function EmbedCard({ entity_type, entity_id, title, status }: EmbedCardData) {
  const [showModal, setShowModal] = useState(false);
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

  return (
    <>
      <button
        type="button"
        onClick={() => setShowModal(true)}
        className="block w-full text-left transition-opacity hover:opacity-80"
      >
        {inner}
      </button>
      {showModal && (
        <EntityPreviewModal
          entityType={entity_type}
          entityId={entity_id}
          title={title}
          status={status}
          href={href}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

export function EntityChip({
  entityType,
  entityId,
  label,
  href,
}: {
  entityType: string;
  entityId?: string;
  label: string;
  href: string | null;
}) {
  const [showModal, setShowModal] = useState(false);
  const icon = ENTITY_ICONS[entityType] ?? '#';
  const colorClass = ENTITY_COLORS[entityType] ?? 'border-border bg-muted text-foreground';

  const inner = (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );

  if (entityId) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex no-underline transition-opacity hover:opacity-80"
        >
          {inner}
        </button>
        {showModal && (
          <EntityPreviewModal
            entityType={entityType}
            entityId={entityId}
            title={label}
            status={null}
            href={href}
            onClose={() => setShowModal(false)}
          />
        )}
      </>
    );
  }

  if (href) {
    return (
      <Link href={href} className="inline-flex no-underline transition-opacity hover:opacity-80">
        {inner}
      </Link>
    );
  }
  return inner;
}
