'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useState, useEffect, useCallback } from 'react';
import { FileText, AlertCircle, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Returns true if embedding `docId` inside a document identified by
 * `currentDocId` would create a circular reference.
 *
 * Detects two cases:
 *  - Direct self-embed (A embeds A): docId === currentDocId
 *  - Indirect cycle (A embeds B, B already embeds A):
 *    currentDocId appears in `embedChain` (the list of doc IDs transitively
 *    embedded by the target doc, returned by the preview API).
 */
export function isCircularEmbed(
  docId: string | null | undefined,
  currentDocId: string | undefined,
  embedChain: string[] = [],
): boolean {
  if (!docId || !currentDocId) return false;
  if (docId === currentDocId) return true;
  return embedChain.includes(currentDocId);
}

// ---------------------------------------------------------------------------
// Extension options
// ---------------------------------------------------------------------------

export interface PageEmbedOptions {
  /** ID of the document currently open in the editor — used to prevent self-embed. */
  currentDocId?: string;
  /** Called when the user clicks an embedded page link. */
  onNavigate?: (slug: string) => void;
}

// ---------------------------------------------------------------------------
// Node-view component
// ---------------------------------------------------------------------------

interface DocPreview {
  id: string;
  title: string;
  icon: string | null;
  slug: string;
  embedChain: string[];
}

type NodeAttrs = {
  docId: string | null;
  title: string | null;
  icon: string | null;
  slug: string | null;
};

function PageEmbedView({ node, updateAttributes, extension }: ReactNodeViewProps) {
  const attrs = node.attrs as NodeAttrs;
  const { docId, title, icon, slug } = attrs;
  const { currentDocId, onNavigate } = extension.options as PageEmbedOptions;

  const [inputSlug, setInputSlug] = useState('');
  const [doc, setDoc] = useState<DocPreview | null>(
    docId
      ? { id: docId, title: title ?? '', icon: icon ?? null, slug: slug ?? '', embedChain: [] }
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Direct circular embed check (A embeds A) — caught from node attrs immediately.
  const circular = isCircularEmbed(docId, currentDocId);

  const fetchDoc = useCallback(
    async (slugOrId: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q: slugOrId });
        if (currentDocId) params.set('currentDocId', currentDocId);
        const res = await fetch(`/api/docs/preview?${params.toString()}`);
        if (!res.ok) {
          setError(res.status === 404 ? 'Document not found' : 'Document unavailable');
          setLoading(false);
          return;
        }
        const json = (await res.json()) as { data: DocPreview };
        const d = json.data;

        // Indirect circular embed check: target doc's embedChain contains currentDocId (A→B→A)
        if (isCircularEmbed(d.id, currentDocId, d.embedChain)) {
          setError('Circular embed detected — this would create an embed cycle.');
          setLoading(false);
          return;
        }

        setDoc(d);
        updateAttributes({ docId: d.id, title: d.title, icon: d.icon ?? null, slug: d.slug });
      } catch {
        setError('Failed to load document');
      } finally {
        setLoading(false);
      }
    },
    [updateAttributes, currentDocId],
  );

  // Auto-fetch when docId is present but doc state not yet populated
  useEffect(() => {
    if (docId && !doc) {
      void fetchDoc(docId);
    }
  }, [docId, doc, fetchDoc]);

  const handleReset = useCallback(() => {
    setDoc(null);
    setError(null);
    setInputSlug('');
    updateAttributes({ docId: null, title: null, icon: null, slug: null });
  }, [updateAttributes]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const val = inputSlug.trim();
      if (val) void fetchDoc(val);
    },
    [inputSlug, fetchDoc],
  );

  // --- Circular embed (direct: A embeds A) ---
  if (circular) {
    return (
      <NodeViewWrapper data-testid="page-embed-circular">
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/8 px-4 py-3 text-sm text-rose-400">
          <AlertCircle className="size-4 shrink-0" />
          <span>Circular embed detected — a document cannot embed itself.</span>
        </div>
      </NodeViewWrapper>
    );
  }

  // --- No doc selected — show picker ---
  if (!docId) {
    return (
      <NodeViewWrapper data-testid="page-embed-picker">
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/4 px-4 py-3"
        >
          <FileText className="size-4 shrink-0 text-[color:var(--operator-muted)]" />
          <input
            type="text"
            value={inputSlug}
            onChange={(e) => setInputSlug(e.target.value)}
            placeholder="Enter document slug or ID…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[color:var(--operator-muted)]"
            autoFocus
          />
          <button
            type="submit"
            className="rounded-lg bg-[color:var(--operator-primary)]/14 px-3 py-1 text-xs font-medium text-[color:var(--operator-primary-soft)] hover:bg-[color:var(--operator-primary)]/24"
          >
            Embed
          </button>
        </form>
      </NodeViewWrapper>
    );
  }

  // --- Loading ---
  if (loading) {
    return (
      <NodeViewWrapper data-testid="page-embed-loading">
        <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-[color:var(--operator-muted)]">
          <RefreshCw className="size-4 shrink-0 animate-spin" />
          <span>Loading document…</span>
        </div>
      </NodeViewWrapper>
    );
  }

  // --- Error / unavailable / circular (indirect) ---
  if (error) {
    return (
      <NodeViewWrapper data-testid="page-embed-error">
        <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-4 py-3">
          <AlertCircle className="size-4 shrink-0 text-[color:var(--operator-muted)]" />
          <span className="flex-1 text-sm text-[color:var(--operator-muted)]">{error}</span>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-[color:var(--operator-primary-soft)] hover:underline"
          >
            Change
          </button>
        </div>
      </NodeViewWrapper>
    );
  }

  // --- Loaded preview ---
  if (doc) {
    return (
      <NodeViewWrapper data-testid="page-embed-preview">
        <div
          role="button"
          tabIndex={0}
          onClick={() => onNavigate?.(doc.slug)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onNavigate?.(doc.slug);
          }}
          className="group flex cursor-pointer items-center gap-3 rounded-xl border border-white/8 bg-white/4 px-4 py-3 transition-colors hover:border-[color:var(--operator-primary)]/30 hover:bg-[color:var(--operator-primary)]/6"
        >
          {doc.icon ? (
            <span className="shrink-0 text-lg">{doc.icon}</span>
          ) : (
            <FileText className="size-5 shrink-0 text-[color:var(--operator-primary-soft)]" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[color:var(--operator-foreground)]">
              {doc.title}
            </p>
            <p className="text-xs text-[color:var(--operator-muted)]">/{doc.slug}</p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleReset();
            }}
            className="text-xs text-[color:var(--operator-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[color:var(--operator-foreground)]"
          >
            Change
          </button>
        </div>
      </NodeViewWrapper>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tiptap extension
// ---------------------------------------------------------------------------

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageEmbed: {
      insertPageEmbed: () => ReturnType;
    };
  }
}

export const PageEmbedExtension = Node.create<PageEmbedOptions>({
  name: 'pageEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return {
      currentDocId: undefined,
      onNavigate: undefined,
    };
  },

  addAttributes() {
    return {
      docId: {
        default: null,
        // Read from data-doc-id (markdown round-trip) or legacy docid attr (HTML format)
        parseHTML: (el) => el.getAttribute('data-doc-id') || el.getAttribute('docid') || null,
        renderHTML: (attrs) => ({ 'data-doc-id': attrs.docId ?? '' }),
      },
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-title') || null,
        renderHTML: (attrs) => ({ 'data-title': attrs.title ?? '' }),
      },
      icon: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-icon') || null,
        renderHTML: (attrs) => ({ 'data-icon': attrs.icon ?? '' }),
      },
      slug: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-slug') || null,
        renderHTML: (attrs) => ({ 'data-slug': attrs.slug ?? '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-page-embed]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Per-attribute renderHTML already maps docId→data-doc-id etc.
    // HTMLAttributes here contains data-doc-id, data-title, data-icon, data-slug.
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-embed': '' })];
  },

  addCommands() {
    return {
      insertPageEmbed:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: {} }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(PageEmbedView);
  },
});
