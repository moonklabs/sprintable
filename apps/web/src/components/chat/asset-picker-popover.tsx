'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { CornerDownLeft, Folder, FolderOpen, RefreshCw, Search } from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import { formatFileSize } from '@/components/docs/extensions/file-node';
import { FILE_TINT_CLASS, fileExtLabel, fileTypeTint } from '@/lib/storage/format';
import type { Asset } from '@/lib/storage/types';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';

interface AssetPickerPopoverProps {
  projectId: string;
  currentFolderId?: string;
  onSelect: (asset: Asset) => void;
  onClose: () => void;
}

/** 검색 범위 — folder_id 파라미터 제어. project/all 은 프로젝트 전역(BE 교차-스코프 미정·design-first). */
type Scope = 'project' | 'folder' | 'all';

/**
 * S6 — 채팅 입력창 스토리지 자산 피커(목업 ① 1:1).
 * 멘션/엔티티 picker 메커니즘 미러: 검색(debounce 200ms → /api/assets)·키보드 nav(↑↓ wrap·↵ 선택·esc 닫기)·
 * a11y(listbox/option/aria-activedescendant/aria-selected). 자산 행=타입 틴트 글리프 + 이름 + 메타.
 */
export function AssetPickerPopover({ projectId, currentFolderId, onSelect, onClose }: AssetPickerPopoverProps) {
  const t = useTranslations('chats');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [scope, setScope] = useState<Scope>('project');
  const [results, setResults] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 마운트 시 검색 입력 포커스.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // 바깥 클릭 닫기 — 메뉴 항목 클릭(피커 오픈)과 같은 틱 충돌 방지 위해 다음 프레임에 리스너 등록.
  useEffect(() => {
    let raf = 0;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    raf = requestAnimationFrame(() => document.addEventListener('mousedown', handler));
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  // debounce 200ms (entity picker 미러).
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  // 자산 검색 — scope 에 따라 folder_id 분기. 응답 형상 { data: { items, next_cursor } }.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(false);
      const params = new URLSearchParams({ project_id: projectId, limit: '20' });
      const q = debouncedQuery.trim();
      if (q) params.set('q', q);
      if (scope === 'folder' && currentFolderId) params.set('folder_id', currentFolderId);
      try {
        const r = await fetch(`/api/assets?${params.toString()}`);
        if (!r.ok) throw new Error('fetch-failed');
        const json: { data?: { items?: Asset[] } } = await r.json();
        if (cancelled) return;
        setResults(json?.data?.items ?? []);
        setSelectedIndex(0);
      } catch {
        if (!cancelled) {
          setError(true);
          setResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, scope, projectId, currentFolderId, reloadKey]);

  // 선택 행 스크롤 인투 뷰.
  useEffect(() => {
    const el = listRef.current?.querySelector(`#asset-opt-${selectedIndex}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const asset = results[selectedIndex] ?? results[0];
      if (asset) onSelect(asset);
    }
  };

  const scopes: { id: Scope; label: string }[] = [
    { id: 'project', label: t('assetScopeProject') },
    ...(currentFolderId ? [{ id: 'folder' as Scope, label: t('assetScopeFolder') }] : []),
    { id: 'all', label: t('assetScopeAll') },
  ];

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t('assetPickerTitle')}
      className="absolute bottom-[54px] left-3 z-40 flex max-h-[380px] w-[372px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-[0_16px_46px_rgba(0,0,0,0.20)]"
    >
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-[13px] pb-[9px] pt-[11px] text-xs font-semibold">
        <FolderOpen className="size-4 shrink-0 text-info" aria-hidden />
        <span className="text-foreground">{t('assetPickerTitle')}</span>
        <span className="ml-auto rounded-[5px] border border-border px-[5px] py-px text-[10px] font-normal text-muted-foreground">
          esc
        </span>
      </div>

      {/* 검색 */}
      <div className="mx-[13px] mb-2 flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-[7px]">
        <Search className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="asset-picker-list"
          aria-activedescendant={results.length > 0 ? `asset-opt-${selectedIndex}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('assetPickerSearchPlaceholder')}
          className="w-full border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* 스코프 칩 */}
      <div className="flex flex-wrap items-center gap-1.5 px-[13px] pb-2">
        {scopes.map((s) => {
          const on = s.id === scope;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setScope(s.id)}
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11px] transition-colors ${
                on ? 'border-transparent bg-info/10 font-semibold text-info' : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {s.id === 'project' ? (
                <span className="inline-block size-[7px] rounded-full bg-brand" aria-hidden />
              ) : s.id === 'folder' ? (
                <Folder className="size-3" aria-hidden />
              ) : null}
              {s.label}
            </button>
          );
        })}
      </div>

      {/* 리스트 + 상태 */}
      <div
        ref={listRef}
        id="asset-picker-list"
        role="listbox"
        aria-label={t('assetPickerTitle')}
        className="flex-1 overflow-y-auto border-t border-border px-1.5 pb-1.5 pt-1"
      >
        {loading ? (
          <ul className="space-y-0.5">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-center gap-2.5 px-2 py-[7px]">
                <Skeleton variant="rect" className="size-[30px] shrink-0 rounded-sm" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton variant="text" className="h-3 w-2/3" />
                  <Skeleton variant="text" className="h-2.5 w-2/5" />
                </div>
              </li>
            ))}
          </ul>
        ) : error ? (
          <div className="px-2 py-3">
            <EmptyState
              className="rounded-md px-4 py-6"
              title={t('assetPickerErrorTitle')}
              action={
                <button
                  type="button"
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {t('assetPickerRetry')}
                </button>
              }
            />
          </div>
        ) : results.length === 0 ? (
          <div className="px-2 py-3">
            <EmptyState
              className="rounded-md px-4 py-6"
              title={debouncedQuery.trim() ? t('assetPickerNoResultsTitle') : t('assetPickerEmptyTitle')}
              description={
                debouncedQuery.trim()
                  ? t('assetPickerNoResultsDesc', { query: debouncedQuery.trim() })
                  : t('assetPickerEmptyDesc')
              }
            />
          </div>
        ) : (
          <ul>
            {results.map((asset, idx) => {
              const sel = idx === selectedIndex;
              const Icon = getFileIcon(asset.content_type);
              const tint = FILE_TINT_CLASS[fileTypeTint(asset.content_type)];
              const ext = fileExtLabel(asset.content_type, asset.name);
              return (
                <li key={asset.id}>
                  <button
                    type="button"
                    id={`asset-opt-${idx}`}
                    role="option"
                    aria-selected={sel}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect(asset);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-sm px-2 py-[7px] text-left transition-colors ${
                      sel ? 'bg-accent' : 'hover:bg-muted'
                    }`}
                  >
                    {/* 썸네일 30×30 — 타입 틴트 글리프(서명 썸네일 필드 부재 → 글리프). */}
                    <span className={`grid size-[30px] shrink-0 place-items-center overflow-hidden rounded-sm ${tint}`}>
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[12.5px] text-foreground ${sel ? 'font-semibold' : ''}`}>
                        {asset.name}
                      </span>
                      <span className="mt-px block text-[10.5px] text-muted-foreground">
                        {ext} · {formatFileSize(asset.size_bytes)}
                      </span>
                    </span>
                    <span
                      className={`flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground ${sel ? 'opacity-100' : 'opacity-0'}`}
                    >
                      <CornerDownLeft className="size-3" aria-hidden />
                      {t('assetPickerHintAttach')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 푸터 */}
      <div className="flex gap-3 border-t border-border px-[13px] py-[7px] text-[10.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border px-1 text-[10px]">↑</kbd>
          <kbd className="rounded border border-border px-1 text-[10px]">↓</kbd>
          {t('assetPickerHintMove')}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border px-1 text-[10px]">↵</kbd>
          {t('assetPickerHintAttach')}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border px-1 text-[10px]">esc</kbd>
          {t('assetPickerHintClose')}
        </span>
      </div>
    </div>
  );
}
