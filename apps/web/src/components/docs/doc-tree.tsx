'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, MoreVertical } from 'lucide-react';
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';

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
}) {
  const childDocs = allDocs.filter((entry) => entry.parent_id === doc.id).sort((a, b) => a.sort_order - b.sort_order);
  const hasChildren = childDocs.length > 0;
  const isFolder = Boolean(doc.is_folder || hasChildren);
  const [expanded, setExpanded] = useState(true);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const isSelected = selectedSlug === doc.slug;
  const menuRef = useRef<HTMLDivElement>(null);

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
    if (isFolder) setExpanded((prev) => !prev);
    onSelect(doc.slug);
  }, [isFolder, doc.slug, onSelect]);

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
        <button
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          className={cn(
            'flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-all',
            isSelected
              ? 'bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)] shadow-[inset_0_0_0_1px_rgba(182,196,255,0.14)]'
              : 'text-[color:var(--operator-foreground)]/88 hover:bg-white/6 hover:text-[color:var(--operator-foreground)]',
          )}
          style={{ paddingLeft: `${depth * 18 + 12}px` }}
          {...attributes}
          {...listeners}
        >
          {isFolder ? (
            expanded ? <ChevronDown className="size-3.5 shrink-0 text-[color:var(--operator-muted)]" /> : <ChevronRight className="size-3.5 shrink-0 text-[color:var(--operator-muted)]" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {doc.icon ? (
            <span className="shrink-0 text-sm">{doc.icon}</span>
          ) : isFolder ? (
            expanded ? <FolderOpen className="size-4 shrink-0 text-[color:var(--operator-tertiary)]" /> : <Folder className="size-4 shrink-0 text-[color:var(--operator-tertiary)]" />
          ) : (
            <FileText className="size-4 shrink-0 text-[color:var(--operator-primary-soft)]" />
          )}
          <span className="flex-1 truncate">{doc.title}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setContextMenuOpen(true);
            }}
            className="opacity-0 transition group-hover:opacity-100"
          >
            <MoreVertical className="size-3.5 text-[color:var(--operator-muted)]" />
          </button>
        </button>
        {contextMenuOpen && (
          <div ref={menuRef} className="absolute left-0 top-full z-50 mt-1 w-48 rounded-xl border border-white/10 bg-[color:var(--operator-panel)] p-1 shadow-lg">
            <button onClick={handleRename} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/8">Rename</button>
            {isFolder && <button onClick={handleAddChild} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/8">Add child</button>}
            <button onClick={handleDelete} className="w-full rounded-lg px-3 py-2 text-left text-sm text-rose-400 hover:bg-rose-500/10">Delete</button>
          </div>
        )}
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
                />
              ))}
            </SortableContext>
          ) : (
            <p
              className="py-1 text-[11px] italic text-[color:var(--operator-muted)]"
              style={{ paddingLeft: `${(depth + 1) * 18 + 28}px` }}
            >
              {emptyFolderLabel}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function DocTree({ docs, selectedSlug, onSelect, onReorder, onMove, onMoveDenied, onRename, onDelete, onAddChild, emptyFolderLabel }: DocTreeProps) {
  const rootDocs = docs.filter((entry) => !entry.parent_id).sort((a, b) => a.sort_order - b.sort_order);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeDoc = docs.find((d) => d.id === active.id);
    const overDoc = docs.find((d) => d.id === over.id);
    if (!activeDoc || !overDoc) return;

    if (activeDoc.parent_id !== overDoc.parent_id) {
      // Cross-parent move: prevent circular (dragging a node into its own subtree)
      if (isDescendant(docs, activeDoc.id, overDoc.id)) {
        onMoveDenied?.('circular');
        return;
      }

      // Require onMove to be wired for cross-parent moves
      if (!onMove) {
        onMoveDenied?.('no-permission');
        return;
      }

      // Place activeDoc as a child of overDoc (overDoc becomes the new parent)
      const newParentId = overDoc.id;
      await onMove(activeDoc.id, newParentId, overDoc.sort_order);
      return;
    }

    // Same-parent reorder (existing behaviour)
    if (!onReorder) return;
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
            <TreeNode key={doc.id} doc={doc} allDocs={docs} selectedSlug={selectedSlug} onSelect={onSelect} onReorder={onReorder} onRename={onRename} onDelete={onDelete} onAddChild={onAddChild} depth={0} emptyFolderLabel={emptyFolderLabel} />
          ))}
        </nav>
      </SortableContext>
    </DndContext>
  );
}
