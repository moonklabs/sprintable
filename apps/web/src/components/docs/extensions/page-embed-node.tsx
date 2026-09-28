'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useState, useEffect, useCallback, useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, AlertCircle, RefreshCw } from 'lucide-react';

import { fetchWithAuth } from '@/lib/db/client';
import { cn } from '@/lib/utils';
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING, HOVER_REVEAL_HIT } from '@/lib/hover-reveal';

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

/** Exported for component tests (story #4371). */
export function PageEmbedView({ node, updateAttributes, extension }: ReactNodeViewProps) {
  // story #3880(§⑤ 낱말 드리프트, 유나 §⑤ 3880-c 확定) — "Embed"/"Change" 원시 영문
  // 정본화. Embed는 chats.embedFormEmbed 기존 키 재사용, Change는 docs 네임스페이스
  // 신규 키(이 파일이 docs 에디터 확장이라 도메인 일치).
  const tChats = useTranslations('chats');
  const tDocs = useTranslations('docs');
  const attrs = node.attrs as NodeAttrs;
  const { docId, title, icon, slug } = attrs;
  const { currentDocId, onNavigate } = extension.options as PageEmbedOptions;

  const [inputSlug, setInputSlug] = useState('');
  // story #4371 — 저장된 임베드의 속성(title · icon · slug)은 첫 그림용 자리표시일 뿐. 열 때 대상 문서를 한 번 조회해
  // 지워짐 · 접근 불가 · 순환이면 오류 줄, 성공이면 최신 값을 그린다(속성은 안 씀 · 예전엔 이 상태가 채워져 있어 조회가 영영 안 돌았다).
  const [doc, setDoc] = useState<DocPreview | null>(
    docId
      ? { id: docId, title: title ?? '', icon: icon ?? null, slug: slug ?? '', embedChain: [] }
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  // 이미 조회로 확인한 docId — 같은 대상을 두 번 조회하지 않는다(입력칸 성공 뒤 속성 갱신 · StrictMode 이중 효과).
  const verifiedDocId = useRef<string | null>(null);

  // Direct circular embed check (A embeds A) — caught from node attrs immediately.
  const circular = isCircularEmbed(docId, currentDocId);

  // mode 'submit' = 입력칸 제출(불러오는 동안 로딩 표시 · 실패면 입력칸 아래 오류 줄 · 초점은 입력칸),
  // mode 'verify' = 저장된 임베드를 열 때 한 번(자리표시 카드를 그대로 두고 조용히 조회 · 실패면 오류 줄).
  const fetchDoc = useCallback(
    async (slugOrId: string, mode: 'submit' | 'verify') => {
      if (mode === 'submit') setLoading(true);
      setError(null);
      const fail = (message: string) => {
        setError(message);
        if (mode === 'submit') inputRef.current?.focus();
      };
      try {
        const params = new URLSearchParams({ q: slugOrId });
        if (currentDocId) params.set('currentDocId', currentDocId);
        const res = await fetchWithAuth(`/api/docs/preview?${params.toString()}`);
        if (!res.ok) {
          fail(res.status === 404 ? tDocs('pageEmbedNotFound') : tDocs('pageEmbedUnavailable'));
          return;
        }
        const json = (await res.json()) as { data: DocPreview };
        const d = json.data;

        // Indirect circular embed check: target doc's embedChain contains currentDocId (A→B→A)
        if (isCircularEmbed(d.id, currentDocId, d.embedChain)) {
          fail(tDocs('pageEmbedCycle'));
          return;
        }

        verifiedDocId.current = d.id;
        setDoc(d);
        // 속성(= 문서 내용)은 사용자가 입력칸에서 대상을 고를 때만 쓴다. 열 때 조회('verify')는 읽기만 — 최신 제목/아이콘은
        // 컴포넌트 상태로만 그린다(보기만 한 사람이 문서를 열어도 내용 · 저장 요청 · «고침» 표시가 생기지 않게, PO 4371).
        if (mode === 'submit') updateAttributes({ docId: d.id, title: d.title, icon: d.icon ?? null, slug: d.slug });
      } catch {
        fail(tDocs('pageEmbedLoadFailed'));
      } finally {
        if (mode === 'submit') setLoading(false);
      }
    },
    [updateAttributes, currentDocId, tDocs],
  );

  // 저장된 임베드(docId 있음)는 열 때 대상 문서를 한 번 조회한다(story #4371).
  useEffect(() => {
    if (!docId || verifiedDocId.current === docId || isCircularEmbed(docId, currentDocId)) return;
    verifiedDocId.current = docId;
    void fetchDoc(docId, 'verify');
  }, [docId, currentDocId, fetchDoc]);

  const handleReset = useCallback(() => {
    setDoc(null);
    setError(null);
    setInputSlug('');
    verifiedDocId.current = null;
    updateAttributes({ docId: null, title: null, icon: null, slug: null });
  }, [updateAttributes]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const val = inputSlug.trim();
      if (val) void fetchDoc(val, 'submit');
    },
    [inputSlug, fetchDoc],
  );

  // --- Circular embed (direct: A embeds A) ---
  if (circular) {
    return (
      <NodeViewWrapper data-testid="page-embed-circular">
        <div className="flex items-center gap-2 rounded-xl border border-destructive-border bg-destructive-tint px-4 py-3 text-sm text-foreground">
          <AlertCircle className="size-4 shrink-0 text-destructive" />
          <span>{tDocs('pageEmbedSelf')}</span>
        </div>
      </NodeViewWrapper>
    );
  }

  // --- No doc selected — show picker ---
  // story #4371 — 제출 실패(찾을 수 없음/불가 · 순환 · 불러오기 실패)는 입력칸 아래 오류 한 줄로(예전엔 이 갈래가 오류 갈래보다
  // 먼저 반환해 오류가 영영 안 그려졌다). 입력값은 그대로 · 초점은 입력칸(fetchDoc).
  if (!docId) {
    return (
      <NodeViewWrapper data-testid="page-embed-picker">
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/4 px-4 py-3"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={inputSlug}
            onChange={(e) => setInputSlug(e.target.value)}
            placeholder={tDocs('pageEmbedPlaceholder')}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-brand/14 px-3 py-1 text-xs font-medium text-brand-text hover:bg-brand/24"
          >
            {tChats('embedFormEmbed')}
          </button>
        </form>
        {error ? (
          <p id={errorId} role="alert" className="mt-1.5 flex items-start gap-1.5 break-keep px-1 text-xs text-destructive [overflow-wrap:anywhere]">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </NodeViewWrapper>
    );
  }

  // --- Loading ---
  if (loading) {
    return (
      <NodeViewWrapper data-testid="page-embed-loading">
        <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-muted-foreground">
          <RefreshCw className="size-4 shrink-0 animate-spin" />
          <span>{tDocs('pageEmbedLoading')}</span>
        </div>
      </NodeViewWrapper>
    );
  }

  // --- Error / unavailable / circular (indirect) ---
  if (error) {
    return (
      <NodeViewWrapper data-testid="page-embed-error">
        <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-4 py-3">
          <AlertCircle className="size-4 shrink-0 text-muted-foreground" />
          {/* story #4371(유나 판) — 한국어 오류 문장이 낱말 중간(음절)에서 꺾이지 않게(입력칸 오류 줄과 같은 break-keep). */}
          <span className="min-w-0 flex-1 break-keep text-sm text-muted-foreground [overflow-wrap:anywhere]">{error}</span>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-brand-text hover:underline"
          >
            {tDocs('pageEmbedChangeAction')}
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
          className="group flex cursor-pointer items-center gap-3 rounded-xl border border-white/8 bg-white/4 px-4 py-3 transition-colors hover:border-brand/30 hover:bg-brand/6"
        >
          {doc.icon ? (
            <span className="shrink-0 text-lg">{doc.icon}</span>
          ) : (
            <FileText className="size-5 shrink-0 text-brand-text" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {doc.title}
            </p>
            <p className="text-xs text-muted-foreground">/{doc.slug}</p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleReset();
            }}
            // story #4345 — 호버 없는 기기에선 늘 · 마우스는 카드 호버 · 초점에서(HOVER_REVEAL).
            className={cn('rounded-sm px-1 text-xs text-muted-foreground transition hover:text-foreground', HOVER_REVEAL_HIT, HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING)}
          >
            {tDocs('pageEmbedChangeAction')}
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
