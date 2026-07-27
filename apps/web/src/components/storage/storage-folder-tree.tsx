'use client';

import { useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Folder as FolderIcon, FolderPlus, Search } from 'lucide-react';
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
  // story #1939: 루트 레벨 폴더 생성(하위 폴더 생성은 후속 — BE는 parent_id 이미 지원).
  // 성공 시 true, 실패(409 중복 등) 시 에러 메시지 문자열을 돌려줘 인라인 폼이 계속 열려있게 한다.
  onCreateFolder: (name: string) => Promise<{ ok: true } | { ok: false; errorMessage: string }>;
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
  onCreateFolder,
}: StorageFolderTreeProps) {
  const t = useTranslations('storage');
  const { isExpanded, toggleExpanded } = useTreeExpanded(projectId);

  // story #1939: 인라인 생성 폼 — 팝오버 대신 트리 패널 안에 그대로 펼쳐서(뷰포트 clamp 필요 0,
  // #1942 결함 클래스 회피) 이름 입력 → 제출. 실패(409 등)는 폼을 닫지 않고 에러만 보여준다.
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const startCreating = () => {
    setCreating(true);
    setNewFolderName('');
    setCreateError(null);
  };
  const cancelCreating = () => {
    setCreating(false);
    setNewFolderName('');
    setCreateError(null);
  };
  const submitCreate = async () => {
    const name = newFolderName.trim();
    if (!name) {
      setCreateError(t('newFolderEmptyError'));
      return;
    }
    setSubmitting(true);
    setCreateError(null);
    const result = await onCreateFolder(name);
    setSubmitting(false);
    if (result.ok) {
      setCreating(false);
      setNewFolderName('');
    } else {
      setCreateError(result.errorMessage);
    }
  };

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
          {/* story #2023 ⓑ: 상태 점=L5, 브랜드 아님 */}
          <span className="size-2 shrink-0 rounded-full bg-info" />
          <span className="truncate">{projectName ?? 'Sprintable'}</span>
          <ChevronDown className="ml-auto size-3.5 shrink-0 opacity-50" />
        </button>
      </div>

      {/* 폴더 검색 + 새 폴더 */}
      <div className="mx-3 mb-1.5 flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-[7px] rounded-[0.5rem] bg-muted/60 px-[9px] py-[7px] text-[12px] text-muted-foreground">
          <Search className="size-3.5 shrink-0 opacity-60" />
          <input
            value={folderSearch}
            onChange={(e) => onFolderSearchChange(e.target.value)}
            placeholder={t('folderSearchPlaceholder')}
            className="w-full min-w-0 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <button
          type="button"
          aria-label={t('newFolderAction')}
          title={t('newFolderAction')}
          onClick={startCreating}
          className="grid size-[30px] shrink-0 place-items-center rounded-[0.5rem] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <FolderPlus className="size-[15px]" />
        </button>
      </div>

      {/* 새 폴더 인라인 폼 — 팝오버 아님(뷰포트 clamp 불요), 트리 패널 내부 고정폭에 그대로 렌더 */}
      {creating ? (
        <div className="mx-3 mb-1.5 space-y-1.5 rounded-[0.5rem] border border-border bg-card p-2">
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => { setNewFolderName(e.target.value); if (createError) setCreateError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submitCreate(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelCreating(); }
            }}
            placeholder={t('newFolderPlaceholder')}
            disabled={submitting}
            className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
          />
          {createError ? <p className="text-[11px] text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{createError}</p> : null}
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={cancelCreating}
              disabled={submitting}
              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-60"
            >
              {t('newFolderCancel')}
            </button>
            <button
              type="button"
              onClick={() => void submitCreate()}
              disabled={submitting}
              className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {t('newFolderConfirm')}
            </button>
          </div>
        </div>
      ) : null}

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
