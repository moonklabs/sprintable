'use client';

import { useMemo } from 'react';
import { Archive, ChevronDown, ChevronRight, Folder as FolderIcon, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useTreeExpanded } from '@/components/docs/use-tree-expanded';
import type { Folder } from '@/lib/storage/types';

interface StorageFolderTreeProps {
  folders: Folder[];
  selectedFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
  projectId: string | undefined;
  projectName: string | undefined;
  folderSearch: string;
  onFolderSearchChange: (value: string) => void;
}

interface FolderNodeProps {
  folder: Folder;
  childrenByParent: Map<string, Folder[]>;
  depth: number;
  selectedFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
}

function FolderNode({
  folder,
  childrenByParent,
  depth,
  selectedFolderId,
  onSelectFolder,
  isExpanded,
  toggleExpanded,
}: FolderNodeProps) {
  const children = childrenByParent.get(folder.id) ?? [];
  const hasChildren = children.length > 0;
  const expanded = isExpanded(folder.id);
  const selected = selectedFolderId === folder.id;

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelectFolder(folder.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectFolder(folder.id);
          }
        }}
        className={cn(
          'flex cursor-pointer select-none items-center gap-[7px] rounded-sm px-2 py-[6px] text-[13px] text-foreground outline-none focus-visible:bg-muted',
          selected ? 'bg-info/10 font-semibold text-info' : 'hover:bg-muted',
        )}
      >
        <span
          className="grid w-[14px] place-items-center text-[10px] opacity-55"
          onClick={(e) => {
            if (hasChildren) {
              e.stopPropagation();
              toggleExpanded(folder.id);
            }
          }}
        >
          {hasChildren ? (expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />) : null}
        </span>
        <span className="grid size-[15px] place-items-center opacity-80">
          <FolderIcon className="size-[15px]" />
        </span>
        <span className="truncate">{folder.name}</span>
      </div>

      {hasChildren && expanded ? (
        <div className="ml-[14px] border-l border-border pl-1">
          {children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              childrenByParent={childrenByParent}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              onSelectFolder={onSelectFolder}
              isExpanded={isExpanded}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StorageFolderTree({
  folders,
  selectedFolderId,
  onSelectFolder,
  projectId,
  projectName,
  folderSearch,
  onFolderSearchChange,
}: StorageFolderTreeProps) {
  const t = useTranslations('storage');
  const { isExpanded, toggleExpanded } = useTreeExpanded(projectId);

  const { roots, childrenByParent } = useMemo(() => {
    const byParent = new Map<string, Folder[]>();
    const ids = new Set(folders.map((f) => f.id));
    const rootList: Folder[] = [];
    for (const f of folders) {
      if (f.parent_id && ids.has(f.parent_id)) {
        const arr = byParent.get(f.parent_id) ?? [];
        arr.push(f);
        byParent.set(f.parent_id, arr);
      } else {
        rootList.push(f);
      }
    }
    return { roots: rootList, childrenByParent: byParent };
  }, [folders]);

  const query = folderSearch.trim().toLowerCase();
  const filtered = useMemo(
    () => (query ? folders.filter((f) => f.name.toLowerCase().includes(query)) : []),
    [folders, query],
  );

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-background">
      {/* 프로젝트 필터(어포던스 — 전환은 앱 레벨 switcher 담당) */}
      <div className="px-3 pb-2 pt-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-[0.5rem] border border-border bg-card px-[10px] py-2 text-[12px] text-foreground"
        >
          <span className="size-2 shrink-0 rounded-full bg-brand" />
          <span className="truncate">{projectName ?? 'Sprintable'}</span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 opacity-50" />
        </button>
      </div>

      {/* 폴더 검색 */}
      <div className="mx-3 mb-1.5 flex items-center gap-[7px] rounded-[0.5rem] bg-muted/60 px-[9px] py-[7px] text-[12px] text-muted-foreground">
        <Search className="size-3.5 shrink-0 opacity-60" />
        <input
          value={folderSearch}
          onChange={(e) => onFolderSearchChange(e.target.value)}
          placeholder={t('folderSearchPlaceholder')}
          className="w-full min-w-0 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* 트리 */}
      <div className="min-h-0 flex-1 overflow-auto px-2 py-1">
        {/* 전체 자산 (folderId null) */}
        <div
          role="button"
          tabIndex={0}
          aria-pressed={selectedFolderId === null}
          onClick={() => onSelectFolder(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectFolder(null);
            }
          }}
          className={cn(
            'flex cursor-pointer select-none items-center gap-[7px] rounded-sm px-2 py-[6px] text-[13px] outline-none focus-visible:bg-muted',
            selectedFolderId === null ? 'bg-info/10 font-semibold text-info' : 'text-foreground hover:bg-muted',
          )}
        >
          <span className="w-[14px]" />
          <span className="grid size-[15px] place-items-center opacity-80">
            <Archive className="size-[15px]" />
          </span>
          <span className="truncate">{t('allAssets')}</span>
        </div>

        {query
          ? filtered.map((f) => (
              <div
                key={f.id}
                role="button"
                tabIndex={0}
                aria-pressed={selectedFolderId === f.id}
                onClick={() => onSelectFolder(f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectFolder(f.id);
                  }
                }}
                className={cn(
                  'flex cursor-pointer select-none items-center gap-[7px] rounded-sm px-2 py-[6px] text-[13px] outline-none focus-visible:bg-muted',
                  selectedFolderId === f.id ? 'bg-info/10 font-semibold text-info' : 'text-foreground hover:bg-muted',
                )}
              >
                <span className="w-[14px]" />
                <span className="grid size-[15px] place-items-center opacity-80">
                  <FolderIcon className="size-[15px]" />
                </span>
                <span className="truncate">{f.name}</span>
              </div>
            ))
          : roots.map((folder) => (
              <FolderNode
                key={folder.id}
                folder={folder}
                childrenByParent={childrenByParent}
                depth={0}
                selectedFolderId={selectedFolderId}
                onSelectFolder={onSelectFolder}
                isExpanded={isExpanded}
                toggleExpanded={toggleExpanded}
              />
            ))}
      </div>
    </aside>
  );
}
