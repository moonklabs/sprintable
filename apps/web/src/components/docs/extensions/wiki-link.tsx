'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { createRoot, type Root } from 'react-dom/client';
import { FileText, AlertCircle } from 'lucide-react';

// ─── WikiLink Node View ───────────────────────────────────────────────────────

interface WikiLinkDoc {
  id: string;
  title: string;
  slug: string;
}

function WikiLinkView({ node, editor }: ReactNodeViewProps) {
  const title = node.attrs.title as string;
  const slug = node.attrs.slug as string | null;
  const [exists, setExists] = useState<boolean | null>(null);

  const { projectId, onNavigate } = (editor.extensionManager.extensions.find(
    (e) => e.name === 'wikiLink',
  )?.options ?? {}) as { projectId?: string; onNavigate?: (slug: string) => void };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!slug || !projectId) { setExists(true); return; }
      try {
        const res = await fetch(`/api/docs?project_id=${projectId}&slug=${encodeURIComponent(slug)}&limit=1`);
        const data = res.ok ? (await res.json() as { data?: unknown[] }) : null;
        if (!cancelled) setExists(Array.isArray(data?.data) && data.data.length > 0);
      } catch {
        if (!cancelled) setExists(true);
      }
    })();
    return () => { cancelled = true; };
  }, [slug, projectId]);

  const handleClick = useCallback(() => {
    if (!slug) return;
    if (onNavigate) { onNavigate(slug); return; }
    window.location.href = `/docs/${slug}`;
  }, [slug, onNavigate]);

  const isNotFound = exists === false;

  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <span
        onClick={handleClick}
        title={isNotFound ? '문서를 찾을 수 없습니다' : title}
        className={`inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[0.9em] transition-colors ${
          isNotFound
            ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
            : 'bg-[color:var(--operator-primary)]/10 text-[color:var(--operator-primary-soft)] hover:bg-[color:var(--operator-primary)]/20'
        }`}
      >
        {isNotFound
          ? <AlertCircle className="size-3 flex-shrink-0" />
          : <FileText className="size-3 flex-shrink-0" />}
        {title}
      </span>
    </NodeViewWrapper>
  );
}

// ─── WikiLink Node ────────────────────────────────────────────────────────────

export interface WikiLinkOptions {
  projectId?: string;
  onNavigate?: (slug: string) => void;
  suggestion: Partial<SuggestionOptions>;
}

export const WikiLinkNode = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {
      projectId: undefined,
      onNavigate: undefined,
      suggestion: {},
    };
  },

  addAttributes() {
    return {
      docId: { default: null },
      title: { default: '' },
      slug: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="wikiLink"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { docId, title, slug, ...rest } = HTMLAttributes as Record<string, unknown>;
    return [
      'span',
      mergeAttributes(
        { 'data-type': 'wikiLink', 'data-doc-id': docId, 'data-title': title, 'data-slug': slug },
        rest,
      ),
      String(title ?? ''),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikiLinkView);
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

// ─── Search Dropdown ──────────────────────────────────────────────────────────

function WikiLinkMenu({
  items,
  command,
}: {
  items: WikiLinkDoc[];
  command: (item: WikiLinkDoc) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1)); e.preventDefault(); }
      if (e.key === 'ArrowUp') { setSelectedIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1)); e.preventDefault(); }
      if (e.key === 'Enter') { const item = items[selectedIndex]; if (item) { command(item); } e.preventDefault(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [items, selectedIndex, command]);

  if (items.length === 0) {
    return (
      <div className="w-56 rounded-xl border border-white/10 bg-[color:var(--operator-surface)] p-3 text-xs text-[color:var(--operator-muted)] shadow-lg">
        문서를 찾을 수 없습니다
      </div>
    );
  }

  return (
    <div ref={menuRef} className="max-h-64 w-56 overflow-y-auto rounded-xl border border-white/10 bg-[color:var(--operator-surface)] p-1 shadow-lg">
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          onClick={() => command(item)}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)]'
              : 'text-[color:var(--operator-foreground)] hover:bg-white/6'
          }`}
        >
          <FileText className="size-3.5 flex-shrink-0 text-[color:var(--operator-muted)]" />
          <span className="truncate text-xs">{item.title}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Suggestion Factory ───────────────────────────────────────────────────────

export function createWikiLinkSuggestion(projectId: string | undefined): Partial<SuggestionOptions> {
  let popup: HTMLElement | null = null;
  let root: Root | null = null;

  return {
    char: '[[',
    allowSpaces: true,
    startOfLine: false,

    items: async ({ query }) => {
      if (!projectId) return [];
      try {
        const params = new URLSearchParams({ project_id: projectId, q: query, limit: '10' });
        const res = await fetch(`/api/docs?${params.toString()}`);
        if (!res.ok) return [];
        const data = await res.json() as { data?: WikiLinkDoc[] };
        return data.data ?? [];
      } catch {
        return [];
      }
    },

    render: () => ({
      onStart(props) {
        popup = document.createElement('div');
        popup.style.cssText = 'position:fixed;z-index:9999';
        document.body.appendChild(popup);

        const rect = props.clientRect?.();
        if (rect) {
          popup.style.top = `${rect.bottom + 4}px`;
          popup.style.left = `${rect.left}px`;
        }

        root = createRoot(popup);
        root.render(
          <WikiLinkMenu
            items={props.items as WikiLinkDoc[]}
            command={(item) => {
              props.command(item);
            }}
          />,
        );
      },

      onUpdate(props) {
        const rect = props.clientRect?.();
        if (rect && popup) {
          popup.style.top = `${rect.bottom + 4}px`;
          popup.style.left = `${rect.left}px`;
        }
        root?.render(
          <WikiLinkMenu
            items={props.items as WikiLinkDoc[]}
            command={(item) => { props.command(item); }}
          />,
        );
      },

      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          popup?.remove(); popup = null; root?.unmount(); root = null;
          return true;
        }
        return false;
      },

      onExit() {
        popup?.remove(); popup = null; root?.unmount(); root = null;
      },
    }),

    command({ editor, range, props }) {
      const item = props as WikiLinkDoc;
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'wikiLink',
        attrs: { docId: item.id, title: item.title, slug: item.slug },
      }).run();
    },
  };
}
