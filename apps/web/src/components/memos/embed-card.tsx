'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

const MdBadge = ({ label }: { label: string }) => (
  <span className="rounded border px-1.5 py-0.5 text-[11px] font-medium border-border bg-muted text-muted-foreground">
    {label}
  </span>
);

const MdBody = ({ content }: { content: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => <p className="mb-2 text-sm leading-6">{children}</p>,
      h1: ({ children }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
      h2: ({ children }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
      h3: ({ children }) => <h3 className="mb-1.5 text-sm font-bold">{children}</h3>,
      ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
      ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
      li: ({ children }) => <li className="text-sm leading-6">{children}</li>,
      pre: ({ children }) => <pre className="mb-2 overflow-x-auto rounded-lg p-3 text-[13px] bg-muted">{children}</pre>,
      code: ({ children }) => <code className="rounded px-1 py-0.5 font-mono text-[13px] bg-muted">{children}</code>,
      blockquote: ({ children }) => <blockquote className="mb-2 border-l-2 pl-3 border-border text-muted-foreground">{children}</blockquote>,
      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
      em: ({ children }) => <em className="italic">{children}</em>,
    }}
  >
    {content}
  </ReactMarkdown>
);

function EntityDetail({ entityType, detail }: { entityType: string; detail: Record<string, unknown> }) {
  if (entityType === 'story') {
    const d = detail as { status?: string; priority?: string; story_points?: number; description?: string; acceptance_criteria?: string };
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {d.status && <MdBadge label={d.status} />}
          {d.priority && <MdBadge label={d.priority} />}
          {d.story_points != null && <MdBadge label={`${d.story_points} SP`} />}
        </div>
        {d.description && <MdBody content={d.description} />}
        {d.acceptance_criteria && (
          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Acceptance Criteria</p>
            <MdBody content={d.acceptance_criteria} />
          </div>
        )}
      </div>
    );
  }

  if (entityType === 'epic') {
    const d = detail as { status?: string; priority?: string; objective?: string; description?: string; target_date?: string; story_points_target?: number };
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {d.status && <MdBadge label={d.status} />}
          {d.priority && <MdBadge label={d.priority} />}
          {d.story_points_target != null && <MdBadge label={`목표 ${d.story_points_target} SP`} />}
          {d.target_date && <MdBadge label={d.target_date} />}
        </div>
        {d.objective && <MdBody content={d.objective} />}
        {d.description && d.description !== d.objective && <MdBody content={d.description} />}
      </div>
    );
  }

  if (entityType === 'doc') {
    const d = detail as { content?: string };
    return d.content ? <MdBody content={d.content} /> : null;
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
      <div className="relative w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
        {/* Header */}
        <div className="flex-shrink-0 flex items-start gap-3 px-6 pt-5 pb-3 border-b border-border">
          <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${colorClass} flex-1 min-w-0`}>
            <span>{icon}</span>
            <span className="font-semibold truncate">{label}</span>
            {status ? (
              <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs bg-black/10 dark:bg-white/10">{status}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground mt-0.5"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              불러오는 중…
            </div>
          ) : detail ? (
            <EntityDetail entityType={entityType} detail={detail} />
          ) : entityType === 'task' ? (
            <p className="text-xs text-muted-foreground py-4">이 엔티티는 별도 페이지가 없는.</p>
          ) : null}
        </div>
        {/* Footer */}
        {href && (
          <div className="flex-shrink-0 px-6 py-3 border-t border-border">
            <Link
              href={href}
              onClick={onClose}
              className="flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              전체 보기
            </Link>
          </div>
        )}
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
