'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, GripVertical, MoreVertical } from 'lucide-react';
import { DndContext, DragEndEvent, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { useTouchSafePointerSensor } from '@/hooks/use-touch-safe-pointer-sensor';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useTreeExpanded } from './use-tree-expanded';

// ─── Preview Card ─────────────────────────────────────────────────────────────

function extractSnippet(content: string, maxChars = 200): string {
  return content
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`\[\]>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function DocPreviewCard({ title, snippet, x, y }: { title: string; snippet: string; x: number; y: number }) {
  const CARD_WIDTH = 280;
  const CARD_EST_HEIGHT = 120;
  const GAP = 12;

  const left = x + GAP + CARD_WIDTH > window.innerWidth
    ? Math.max(8, x - GAP - CARD_WIDTH)
    : x + GAP;
  const top = Math.min(y, window.innerHeight - CARD_EST_HEIGHT - 8);

  return createPortal(
    <div
      style={{ position: 'fixed', left, top, width: CARD_WIDTH, zIndex: 9999, pointerEvents: 'none' }}
      className="rounded-xl border border-border bg-background p-3"
    >
      <p className="mb-1 text-xs font-semibold text-foreground truncate">{title}</p>
      {snippet ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground line-clamp-4">{snippet}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground opacity-60">내용 없음</p>
      )}
    </div>,
    document.body,
  );
}

interface Doc {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  is_folder?: boolean;
  updated_at?: string;
}

export type DocSortMode = 'manual' | 'title' | 'updated_at';

// story #2167: 트리 렌더 정렬만 갈아끼운다 — sort_order 값 자체는 안 건드린다(수동 순서는
// 'manual'로 돌아오면 그대로 남아있다). 'updated_at' 결측(구 데이터 등)은 정렬 끝으로 밀어
// undefined 비교로 순서가 흔들리는 것을 막는다.
export function compareDocsForSort(a: Doc, b: Doc, mode: DocSortMode): number {
  if (mode === 'title') return a.title.localeCompare(b.title, 'ko');
  if (mode === 'updated_at') {
    const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return bt - at; // 최근 수정 먼저
  }
  return a.sort_order - b.sort_order;
}

/**
 * Returns true if `nodeId` is a descendant of `ancestorId` in the doc tree.
 * Used to prevent circular moves (dropping a node into its own subtree).
 */
export function isDescendant(docs: Doc[], ancestorId: string, nodeId: string): boolean {
  const visited = new Set<string>();
  let currentId: string | null = nodeId;
  while (currentId !== null) {
    if (visited.has(currentId)) break; // cycle safety guard
    visited.add(currentId);
    const node = docs.find((d) => d.id === currentId);
    if (!node) break;
    if (node.parent_id === ancestorId) return true;
    currentId = node.parent_id;
  }
  return false;
}

interface DocTreeProps {
  docs: Doc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onReorder?: (docId: string, newSortOrder: number, siblings: Doc[]) => Promise<void>;
  onMove?: (docId: string, newParentId: string | null, newSortOrder: number) => Promise<void>;
  onMoveDenied?: (reason: 'circular' | 'no-permission' | 'sort-mode-active') => void;
  onRename?: (docId: string, newTitle: string) => Promise<void>;
  onDelete?: (docId: string) => Promise<void>;
  onAddChild?: (parentId: string) => Promise<void>;
  // story #1950 — 폴더 트리 안에서 바로 하위 폴더를 만드는 진입점(부모 지정). 이름 입력은
  // 트리 안 인라인 폼(docs-client-layout.tsx)이 맡는다 — 여기선 "어느 부모 아래 만들지"만 넘긴다.
  onAddChildFolder?: (parentId: string) => void;
  emptyFolderLabel?: string;
  projectId?: string;
  // story #2167: 검색-중 트리 하이라이트/필터(visibleIds·matchedIds·searchQuery·isSearching)는
  // 제거했다 — PO 판정(나): 검색어가 있을 때 "이 문서가 있는가"의 답은 서버 전문검색만이 낸다
  // (로컬 트리는 사본이라 진실이 아님). 검색 UI는 별도 플랫 리스트(docs-client-layout.tsx의
  // 서버검색 결과 렌더)로 분리됐고, DocTree는 다시 순수 "검색어 없을 때의 트리 브라우징"
  // 전용으로 돌아간다. sortMode만 추가 — 수동/이름순/수정일순 표시 정렬(sort_order 비파괴).
  sortMode?: DocSortMode;
}

function TreeNode({
  doc,
  allDocs,
  selectedSlug,
  onSelect,
  onReorder,
  onRename,
  onDelete,
  onAddChild,
  onAddChildFolder,
  depth = 0,
  emptyFolderLabel = 'No child docs',
  projectId,
  isExpanded,
  onToggleExpanded,
  sortMode = 'manual',
}: {
  doc: Doc;
  allDocs: Doc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onReorder?: (docId: string, newSortOrder: number, siblings: Doc[]) => Promise<void>;
  onRename?: (docId: string, newTitle: string) => Promise<void>;
  onDelete?: (docId: string) => Promise<void>;
  onAddChild?: (parentId: string) => Promise<void>;
  onAddChildFolder?: (parentId: string) => void;
  depth?: number;
  emptyFolderLabel?: string;
  projectId?: string;
  isExpanded: (id: string, defaultValue?: boolean) => boolean;
  onToggleExpanded: (id: string) => void;
  sortMode?: DocSortMode;
}) {
  const t = useTranslations('docs');
  const childDocs = allDocs.filter((entry) => entry.parent_id === doc.id).sort((a, b) => compareDocsForSort(a, b, sortMode));
  const hasChildren = childDocs.length > 0;
  const isFolder = Boolean(doc.is_folder || hasChildren);
  const expanded = isExpanded(doc.id);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  // story #2416 — native confirm() 대체. 각 TreeNode가 자기 대상(doc)의 삭제-확認만 소유.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const isSelected = selectedSlug === doc.slug;
  const menuRef = useRef<HTMLDivElement>(null);

  // Preview state
  const [preview, setPreview] = useState<{ title: string; snippet: string } | null>(null);
  const [previewPos, setPreviewPos] = useState({ x: 0, y: 0 });
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    hoverTimerRef.current = setTimeout(() => {
      if (!projectId) return;
      void fetch(`/api/docs?project_id=${projectId}&slug=${encodeURIComponent(doc.slug)}&limit=1`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: { data?: Array<{ title: string; content?: string }> } | null) => {
          const d = data?.data?.[0];
          if (!d) return;
          setPreview({ title: d.title, snippet: extractSnippet(d.content ?? '') });
          setPreviewPos({ x: clientX, y: clientY });
        })
        .catch(() => { /* ignore */ });
    }, 300);
  }, [doc.slug, projectId]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setPreview(null);
  }, []);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: doc.id,
    data: { doc },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  useEffect(() => {
    if (!contextMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenuOpen]);

  const handleClick = useCallback(() => {
    if (isFolder) onToggleExpanded(doc.id);
    onSelect(doc.slug);
  }, [isFolder, doc.id, doc.slug, onSelect, onToggleExpanded]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuOpen(true);
  }, []);

  const handleRename = useCallback(() => {
    const newTitle = prompt('Enter new title:', doc.title);
    if (newTitle && newTitle !== doc.title && onRename) {
      void onRename(doc.id, newTitle);
    }
    setContextMenuOpen(false);
  }, [doc, onRename]);

  const handleDelete = useCallback(() => {
    setDeleteConfirmOpen(true);
    setContextMenuOpen(false);
  }, []);

  const confirmDelete = useCallback(() => {
    setDeleteConfirmOpen(false);
    if (onDelete) void onDelete(doc.id);
  }, [doc.id, onDelete]);

  const handleAddChild = useCallback(() => {
    if (onAddChild) {
      void onAddChild(doc.id);
    }
    setContextMenuOpen(false);
  }, [doc.id, onAddChild]);

  const handleAddChildFolder = useCallback(() => {
    onAddChildFolder?.(doc.id);
    setContextMenuOpen(false);
  }, [doc.id, onAddChildFolder]);

  return (
    <div ref={setNodeRef} style={style}>
      <div className="group relative">
        {preview && <DocPreviewCard title={preview.title} snippet={preview.snippet} x={previewPos.x} y={previewPos.y} />}
        {/* Drag handle — listeners isolated here to avoid blocking click */}
        <div
          {...attributes}
          {...listeners}
          className="absolute top-1/2 z-10 -translate-y-1/2 cursor-grab touch-none opacity-0 transition group-hover:opacity-100"
          style={{ left: `${Math.min(depth * 14 + 4, 68)}px` }}
        >
          <GripVertical className="size-3 text-muted-foreground" />
        </div>
        <button
          data-doc-id={doc.id}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg pl-3 pr-7 py-2 text-left text-xs transition-all',
            isSelected
              ? 'bg-primary/10 text-primary'
              : 'text-foreground/88 hover:bg-muted hover:text-foreground',
          )}
          style={{ paddingLeft: `${Math.min(depth * 14 + 8, 72)}px` }}
        >
          {isFolder ? (
            expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {doc.icon ? (
            <span className="shrink-0 text-sm">{doc.icon}</span>
          ) : isFolder ? (
            expanded ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate">
            {doc.title}
          </span>
        </button>
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setContextMenuOpen(true);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setContextMenuOpen(true); } }}
          className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition group-hover:opacity-100"
        >
          <MoreVertical className="size-3.5 text-muted-foreground" />
        </div>
        <div
          ref={menuRef}
          className={cn(
            'absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-border bg-popover p-1',
            contextMenuOpen ? 'block' : 'hidden',
          )}
        >
          <button onClick={handleRename} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted">{t('docTreeRename')}</button>
          {isFolder && <button onClick={handleAddChild} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted">{t('docTreeAddChild')}</button>}
          {isFolder && <button onClick={handleAddChildFolder} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted">{t('docTreeAddChildFolder')}</button>}
          <button onClick={handleDelete} className="w-full rounded-md px-3 py-2 text-left text-sm text-foreground hover:bg-destructive/10">{t('docTreeDelete')}</button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('docTreeDeleteTitle')}
        description={t.rich('docTreeDeleteBody', {
          title: doc.title,
          b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b>,
        })}
        cancelLabel={t('cancel')}
        confirmLabel={t('deleteDoc')}
        onConfirm={confirmDelete}
      />

      {isFolder && expanded && (
        <>
          {hasChildren ? (
            <SortableContext items={childDocs.map((d) => d.id)} strategy={verticalListSortingStrategy}>
              {childDocs.map((child) => (
                <TreeNode
                  key={child.id}
                  doc={child}
                  allDocs={allDocs}
                  selectedSlug={selectedSlug}
                  onSelect={onSelect}
                  onReorder={onReorder}
                  onRename={onRename}
                  onDelete={onDelete}
                  onAddChild={onAddChild}
                  onAddChildFolder={onAddChildFolder}
                  depth={depth + 1}
                  emptyFolderLabel={emptyFolderLabel}
                  projectId={projectId}
                  isExpanded={isExpanded}
                  onToggleExpanded={onToggleExpanded}
                  sortMode={sortMode}
                />
              ))}
            </SortableContext>
          ) : (
            <p
              className="py-1 text-[11px] italic text-muted-foreground"
              style={{ paddingLeft: `${Math.min((depth + 1) * 14 + 24, 88)}px` }}
            >
              {emptyFolderLabel}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function DocTree({ docs, selectedSlug, onSelect, onReorder, onMove, onMoveDenied, onRename, onDelete, onAddChild, onAddChildFolder, emptyFolderLabel, projectId, sortMode = 'manual' }: DocTreeProps) {
  const rootDocs = docs.filter((entry) => !entry.parent_id).sort((a, b) => compareDocsForSort(a, b, sortMode));
  // story #2167: 이름순/수정일순 보기에서는 드래그 재정렬을 막는다 — sort_order 기반 드롭
  // 위치 계산이 화면 순서와 안 맞아 엉뚱한 곳에 꽂히는 것을 막기 위함(수동 순서 자체는
  // 안전하게 보존되지만, 사용자가 보는 순서와 실제 재정렬 결과가 어긋나는 혼란을 원천 차단).
  const dragEnabled = sortMode === 'manual';
  // story #1988(C): 순수 PointerSensor는 모바일 터치 스크롤을 드래그로 하이재킹한다 —
  // kanban-board.tsx 0d142311 fix와 동일하게 터치는 드래그 활성화 자체를 배제.
  const sensors = useTouchSafePointerSensor(5);
  const { isExpanded, toggleExpanded } = useTreeExpanded(projectId);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!dragEnabled) { onMoveDenied?.('sort-mode-active'); return; }

    const activeDoc = docs.find((d) => d.id === active.id);
    const overDoc = docs.find((d) => d.id === over.id);
    if (!activeDoc || !overDoc) return;

    // Drop position 기반으로 reorder vs 자식 이동 구분:
    // over 항목의 상단 25% / 하단 25% → same-level reorder
    // 중앙 50% → overDoc을 부모로 이동
    const overRect = over.rect;
    const activeTranslated = active.rect.current.translated;
    const activeCenterY = activeTranslated
      ? activeTranslated.top + activeTranslated.height / 2
      : overRect.top + overRect.height / 2;
    const relativeY = (activeCenterY - overRect.top) / overRect.height;
    const dropIntoParent = relativeY > 0.25 && relativeY < 0.75;

    if (dropIntoParent) {
      // 자식으로 이동 (overDoc이 새 부모)
      if (activeDoc.parent_id === overDoc.id) return; // 이미 자식
      if (isDescendant(docs, activeDoc.id, overDoc.id)) {
        onMoveDenied?.('circular');
        return;
      }
      if (!onMove) {
        onMoveDenied?.('no-permission');
        return;
      }
      await onMove(activeDoc.id, overDoc.id, overDoc.sort_order);
      return;
    }

    // Same-level reorder (상단/하단 25% 드롭)
    if (!onReorder) return;
    if (activeDoc.parent_id !== overDoc.parent_id) {
      // Cross-parent reorder: overDoc과 같은 레벨로 이동
      if (isDescendant(docs, activeDoc.id, overDoc.id)) {
        onMoveDenied?.('circular');
        return;
      }
      if (!onMove) {
        onMoveDenied?.('no-permission');
        return;
      }
      await onMove(activeDoc.id, overDoc.parent_id, overDoc.sort_order);
      return;
    }

    const siblings = docs.filter((d) => d.parent_id === activeDoc.parent_id).sort((a, b) => a.sort_order - b.sort_order);
    const oldIndex = siblings.findIndex((d) => d.id === active.id);
    const newIndex = siblings.findIndex((d) => d.id === over.id);

    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const newSortOrder = siblings[newIndex]!.sort_order;
    await onReorder(activeDoc.id, newSortOrder, siblings);
  }, [docs, onReorder, onMove, onMoveDenied, dragEnabled]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={rootDocs.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <nav className="space-y-1">
          {rootDocs.map((doc) => (
            <TreeNode key={doc.id} doc={doc} allDocs={docs} selectedSlug={selectedSlug} onSelect={onSelect} onReorder={onReorder} onRename={onRename} onDelete={onDelete} onAddChild={onAddChild} onAddChildFolder={onAddChildFolder} depth={0} emptyFolderLabel={emptyFolderLabel} projectId={projectId} isExpanded={isExpanded} onToggleExpanded={toggleExpanded} sortMode={sortMode} />
          ))}
        </nav>
      </SortableContext>
    </DndContext>
  );
}
