'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, MoreVertical } from 'lucide-react';
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
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
      className="rounded-xl border border-border bg-background p-3 shadow-lg"
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
  onMoveDenied?: (reason: 'circular' | 'no-permission') => void;
  onRename?: (docId: string, newTitle: string) => Promise<void>;
  onDelete?: (docId: string) => Promise<void>;
  onAddChild?: (parentId: string) => Promise<void>;
  emptyFolderLabel?: string;
  projectId?: string;
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
  depth = 0,
  emptyFolderLabel = 'No child docs',
  projectId,
  isExpanded,
  onToggleExpanded,
}: {
  doc: Doc;
  allDocs: Doc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onReorder?: (docId: string, newSortOrder: number, siblings: Doc[]) => Promise<void>;
  onRename?: (docId: string, newTitle: string) => Promise<void>;
  onDelete?: (docId: string) => Promise<void>;
  onAddChild?: (parentId: string) => Promise<void>;
  depth?: number;
  emptyFolderLabel?: string;
  projectId?: string;
  isExpanded: (id: string, defaultValue?: boolean) => boolean;
  onToggleExpanded: (id: string) => void;
}) {
  const childDocs = allDocs.filter((entry) => entry.parent_id === doc.id).sort((a, b) => a.sort_order - b.sort_order);
  const hasChildren = childDocs.length > 0;
  const isFolder = Boolean(doc.is_folder || hasChildren);
  const expanded = isExpanded(doc.id);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
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
    if (confirm(`Delete "${doc.title}"?`) && onDelete) {
      void onDelete(doc.id);
    }
    setContextMenuOpen(false);
  }, [doc, onDelete]);

  const handleAddChild = useCallback(() => {
    if (onAddChild) {
      void onAddChild(doc.id);
    }
    setContextMenuOpen(false);
  }, [doc.id, onAddChild]);

  return (
    <div ref={setNodeRef} style={style}>
      <div className="group relative">
        {preview && <DocPreviewCard title={preview.title} snippet={preview.snippet} x={previewPos.x} y={previewPos.y} />}
        <button
          data-doc-id={doc.id}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className={cn(
            'flex w-full items-center gap-2 rounded-2xl pl-3 pr-7 py-2 text-left text-[13px] transition-all',
            isSelected
              ? 'bg-primary/10 text-primary'
              : 'text-foreground/88 hover:bg-muted hover:text-foreground',
          )}
          style={{ paddingLeft: `${Math.min(depth * 14 + 8, 72)}px` }}
          {...attributes}
          {...listeners}
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
          <span className="flex-1 truncate">{doc.title}</span>
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
            'absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-border bg-popover p-1 shadow-md',
            contextMenuOpen ? 'block' : 'hidden',
          )}
        >
          <button onClick={handleRename} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted">Rename</button>
          {isFolder && <button onClick={handleAddChild} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted">Add child</button>}
          <button onClick={handleDelete} className="w-full rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10">Delete</button>
        </div>
      </div>

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
                  depth={depth + 1}
                  emptyFolderLabel={emptyFolderLabel}
                  projectId={projectId}
                  isExpanded={isExpanded}
                  onToggleExpanded={onToggleExpanded}
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

export function DocTree({ docs, selectedSlug, onSelect, onReorder, onMove, onMoveDenied, onRename, onDelete, onAddChild, emptyFolderLabel, projectId }: DocTreeProps) {
  const rootDocs = docs.filter((entry) => !entry.parent_id).sort((a, b) => a.sort_order - b.sort_order);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const { isExpanded, toggleExpanded } = useTreeExpanded(projectId);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

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
  }, [docs, onReorder, onMove, onMoveDenied]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={rootDocs.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <nav className="space-y-1">
          {rootDocs.map((doc) => (
            <TreeNode key={doc.id} doc={doc} allDocs={docs} selectedSlug={selectedSlug} onSelect={onSelect} onReorder={onReorder} onRename={onRename} onDelete={onDelete} onAddChild={onAddChild} depth={0} emptyFolderLabel={emptyFolderLabel} projectId={projectId} isExpanded={isExpanded} onToggleExpanded={toggleExpanded} />
          ))}
        </nav>
      </SortableContext>
    </DndContext>
  );
}
