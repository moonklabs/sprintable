'use client';

import { dropZoneFor, planDrop, type DocMovePlan, type DropZone } from './doc-move-plan';
import { DocRenameDialog } from './doc-rename-dialog';
import { createContext, useContext, useId, useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { pickEulReulJosa } from '@/lib/korean-particle';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, GripVertical, MoreVertical } from 'lucide-react';
import { DndContext, DragOverlay, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent, type Modifier } from '@dnd-kit/core';
import type { Coordinates } from '@dnd-kit/utilities';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING, HOVER_REVEAL_HIT } from '@/lib/hover-reveal';
import { useTouchSafePointerSensor } from '@/hooks/use-touch-safe-pointer-sensor';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useTreeExpanded } from './use-tree-expanded';
import { fetchWithAuth } from '@/lib/db/client';
import { DOC_STATUS_TONE, toDocStatusFilter } from './lib/doc-status-tone';
import { AnchoredPopover, isOutsidePress, usePortalMenuKeys } from '@/components/shared/anchored-popover';
import { Button } from '@/components/ui/button';
import { docMoveAnnouncement, menuMoveState, withEffectiveParents, type DocMoveAction, type MenuMoveResult } from './lib/doc-move';

// story #2963 §3 — proof 상태 도트(6px). 색은 도트에만(§4 대비 규율).
function StatusDot({ status }: { status: string | undefined }) {
  const tone = DOC_STATUS_TONE[toDocStatusFilter(status)];
  return <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} aria-hidden="true" />;
}

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
  const t = useTranslations('docs');
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
        <p className="text-[11px] text-muted-foreground opacity-60">{t('noContentPreview')}</p>
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
  // story #2963 §3 — 레일 v2 proof 상태 도트 소스.
  status?: string;
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
  // story #4348 — 같은 번호면 id로(서버 목록 · 커서와 같은 `(sort_order, id)`). 안 그러면 새로 만든 문서처럼 앞에 끼운 것이 화면 순서와
  // «⋮» 위로 · 아래로가 보는 순서(doc-move-plan siblingsInServerOrder)를 어긋나게 해, 보이는 옆 문서가 아닌 문서와 자리를 바꿨다.
  return a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

/**
 * story #4348 — «⋮» 메뉴로 문서 자리 옮기기(키보드 · 터치). 트리 전체가 한 번에 쓰는 것(옮기기 요청 · 안 받은 페이지 있음)만 문맥으로 내린다
 * (TreeNode 재귀 호출마다 props를 늘리지 않게). 없으면(호출부가 onMenuMove를 안 넘김) 옮기기 항목 자체가 없다.
 */
/**
 * story #4348 — 옮긴 뒤 알림(aria-live) 문구 키. i18n 가드(verify:no-unused-i18n-keys · A″)가 알아보는 모양:
 * `useTranslations('docs')`를 여는 이 파일 안 `Record<string, string>` 리터럴 표 값 → `docs.<값>`으로 셈(PO 2026-09-27 17:04Z · 예외 목록 등재 대신).
 */
/**
 * story #4348 — «⋮» 메뉴 항목 **전부**(이름 변경 · 위로 · 아래로 · 폴더로 · 하위 문서/폴더 추가 · 삭제 · 고르개 줄)의 한 정의 = 디자인 Button(ghost) + 이 클래스.
 * 유나 #4730(design CR 5860943821): 새 항목만 ghost · 기존 넷이 날 button이면 ↓로 훑을 때 초점 표시가 파란 outline ↔ 시트론 링으로 번갈았다 → 한 정의.
 * 높이 자동 · 테두리 0 · 왼쪽 정렬 · 보통 굵기 · 꺼짐 muted(호버 배경 없음 — 다크도: ghost의 dark:hover:bg-muted/50이 이기지 않게). 삭제만 호버를 destructive-tint로 덮는다(DOC_MENU_ITEM_DESTRUCTIVE).
 * `transition-colors`(Button 기본 transition-all 대신): 팝오버는 붙는 순간 visibility:hidden → 자리 잡고 보임(AnchoredPopover)인데, transition-all이면
 * 물려받은 visibility도 전이라 열리는 그 순간 첫 항목이 아직 hidden → usePortalMenuKeys의 첫 항목 focus()가 헛돌아 초점이 «⋮»에 남았다(실 브라우저 · jsdom은 못 봄).
 */
const DOC_MENU_ITEM = 'h-auto min-h-0 w-full justify-start gap-2 border-0 px-3 py-2 text-left text-sm font-normal transition-colors aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent dark:aria-disabled:hover:bg-transparent';
const DOC_MENU_ITEM_DESTRUCTIVE = cn(DOC_MENU_ITEM, 'hover:bg-destructive-tint dark:hover:bg-destructive-tint');

const DOC_MOVE_ANNOUNCE_KEY: Record<string, string> = {
  position: 'docTreeMovedPosition',
  positionOnly: 'docTreeMovedPositionOnly',
  intoFolder: 'docTreeMovedIntoFolder',
  topLevel: 'docTreeMovedToTopLevel',
};

const DocMoveCtx = createContext<{ requestMove: (docId: string, action: DocMoveAction) => void; hasMore: boolean; filtered: boolean } | null>(null);

interface DocTreeProps {
  docs: Doc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  // story #4366(까디르) — 저장이 됐는지 돌려준다(실패해도 resolve — 알림 · 트리 다시 읽기는 저장 함수 몫). 펼침은 성공일 때만.
  onReorder?: (plan: DocMovePlan) => Promise<boolean>;
  onMove?: (plan: DocMovePlan) => Promise<boolean>;
  onMoveDenied?: (reason: 'circular' | 'no-permission' | 'sort-mode-active' | 'tag-filter-active') => void;
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
  /**
   * story #4348 — «⋮» 옮기기 저장(레이아웃이 낙관 반영 → 저장 → 서버 번호 · 실패면 되돌림). 옮긴 계획을 돌려주면 트리가 알림(aria-live) ·
   * 초점(옮긴 행)을 맡는다. 실패면 null(레이아웃이 moveFailed 알림).
   */
  onMenuMove?: (docId: string, action: DocMoveAction) => Promise<MenuMoveResult>;
  /** 아직 안 받은 문서 페이지가 있다 — 받은 형제 중 마지막 문서의 «아래로»를 끈다(다음 형제가 안 받은 자리일 수 있음). */
  hasMore?: boolean;
  /** story #4376 — 태그 필터가 켜져 있으면 옮기기(끌기 · «⋮» 이동) 전부 끔. */
  filtered?: boolean;
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
  emptyFolderLabel,
  projectId,
  isExpanded,
  onToggleExpanded,
  sortMode = 'manual',
  dropTarget = null,
}: {
  doc: Doc;
  allDocs: Doc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onReorder?: (plan: DocMovePlan) => Promise<boolean>;
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
  dropTarget?: DropTarget | null;
}) {
  const t = useTranslations('docs');
  const childDocs = allDocs.filter((entry) => entry.parent_id === doc.id).sort((a, b) => compareDocsForSort(a, b, sortMode));
  const hasChildren = childDocs.length > 0;
  const isFolder = Boolean(doc.is_folder || hasChildren);
  const expanded = isExpanded(doc.id);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  // story #4349 AC5(유나 실측) — 행 메뉴(82px)가 목록(서랍 `overflow-y-auto` · 데스크톱 사이드바 `overflow-y-auto`) 아래 끝에서 세로로 잘려
  // «이름 변경»만 보였다. 이제 열릴 때만 body로 포털(`AnchoredPopover`) → 행 오른쪽 끝에 맞춰 아래 · 모자라면 위로 · 가로는 4342 클램프.
  // 포털이라 DOM 순서상 «⋮» 뒤가 아니다 → 열면 첫 항목으로 초점 · ↑↓ · Tab이 끝을 넘거나 Esc면 닫고 «⋮»로 돌려준다.
  const rowRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLDivElement>(null);
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
      void fetchWithAuth(`/api/docs?project_id=${projectId}&slug=${encodeURIComponent(doc.slug)}&limit=1`)
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

  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: doc.id,
    data: { doc },
  });

  // story #4366 — 끌 대상 상자 = **이 행**(예전엔 자식까지 감싼 바깥 상자라 펼친 폴더 행이 그 상자의 위 25% 안 → 늘 «앞/뒤»로 읽혔다).
  // 판정 표시(아래)도 이 행 기준이라 한 묶음(ref · 표시 기준 이름)으로 둔다.
  // 같은 행이 메뉴 포털의 기준(rowRef)이기도 하다 → ref 둘을 한 칸에.
  const setRowNode = useCallback((node: HTMLDivElement | null) => { setNodeRef(node); rowRef.current = node; }, [setNodeRef]);
  const dropTargetProps = { ref: setRowNode, 'data-drop-target': doc.id } as const;
  // 끄는 동안 다른 행은 움직이지 않는다(자리 비키기 transform을 걸지 않음) — 행이 밀리면 포인터 아래 행과 판정 상자가 어긋난다.
  // 끄는 행은 제자리에서 흐리게 · 포인터를 따라가는 건 DragOverlay 복제.
  const style = { opacity: isDragging ? 0.5 : 1 };
  const zone = dropTarget?.overId === doc.id ? dropTarget.zone : null;
  const textIndent = Math.min(depth * 14 + 8, 72);
  // 펼친 폴더의 «뒤» = 그 폴더 다음 형제 자리(자식들 아래) → 선은 하위 트리 끝에(선이 가리키는 곳 = 들어가는 곳).
  const afterLineAtSubtreeEnd = zone === 'after' && isFolder && expanded && hasChildren;

  // 포털 메뉴 키보드 길(열면 첫 항목 · ↑↓ · Tab 넘김/Esc = 닫고 «⋮»로 · Esc는 서랍 트랩까지 안 감) — 공용 훅(#4349).
  const closeMenu = useCallback(() => setContextMenuOpen(false), []);
  // 까디르(4724) — 메뉴 ARIA(트리거 aria-haspopup · aria-expanded · aria-controls / 패널 id · role=menu)도 같은 훅이 준다 · 항목 role=menuitem은 여기서.
  const { onPopoverKeyDown: handleMenuKeyDown, onTriggerKeyDown: handleMenuTriggerKeyDown, triggerProps: menuTriggerProps, popoverProps: menuPopoverProps } = usePortalMenuKeys({ open: contextMenuOpen, onClose: closeMenu, popoverRef: menuRef, triggerRef: menuTriggerRef, kind: 'menu' });
  // story #4348 — «⋮» 옮기기(위로 · 아래로 · 폴더로). 폴더로는 메뉴 안에서 목록을 바꿔 고른다(고르개). 꺼진 항목은 숨기지 않고 aria-disabled(초점 닿음) +
  // 까닭 줄(aria-describedby) — 정렬 모드 = moveSortModeActiveError 재사용(유나 확정).
  const moveCtx = useContext(DocMoveCtx);
  const [pickerOpen, setPickerOpen] = useState(false);
  const sortNoteId = useId();
  const unloadedNoteId = useId();
  const filterNoteId = useId();
  const pickerTitleId = useId();
  // 고르개 순서 = 트리 보기와 같은 비교(유나 #4730 — 깊이 우선 · 들여쓰기).
  const moveState = moveCtx && contextMenuOpen ? menuMoveState(allDocs, doc.id, sortMode, moveCtx.hasMore, (a, b) => compareDocsForSort(a, b, sortMode), moveCtx.filtered) : null;
  const openMenu = useCallback(() => { setPickerOpen(false); setContextMenuOpen(true); }, []);
  // 고르개 줄 이름 표(줄마다 `{moveTargetTitles.get(target.id)}`로 그림 — 행마다 갈리는 라벨을 가드가 알아보는 «루프 필드로 표 조회» 모양:
  // verify:no-new-repeated-row-action-names). 폴더 제목뿐(«· ID» 꼬리 없음)이라 한 덩어리 truncate가 맞다 — 꼬리 붙은 행 라벨(RowName 가드의 …Labels)과 다른 것.
  const moveTargetTitles = new Map<string | null, string>((moveState?.targets ?? []).map((x) => [x.id, x.id === null ? t('docTreeMoveTopLevel') : (allDocs.find((d) => d.id === x.id)?.title?.trim() || t('newDocDefaultTitle'))]));
  const runMove = (action: DocMoveAction, enabled: boolean) => {
    if (!enabled || !moveCtx) return;
    setContextMenuOpen(false);
    moveCtx.requestMove(doc.id, action);
  };
  useEffect(() => {
    if (contextMenuOpen && pickerOpen) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [contextMenuOpen, pickerOpen]);

  useEffect(() => {
    if (!contextMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (isOutsidePress(menuRef.current, e.target)) setContextMenuOpen(false);
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
    setPickerOpen(false);
    setContextMenuOpen(true);
  }, []);

  // story #4359 — 브라우저 prompt(영어 고정) 대신 디자인 창.
  const [renameOpen, setRenameOpen] = useState(false);
  const handleRename = useCallback(() => {
    setContextMenuOpen(false);
    setRenameOpen(true);
  }, []);

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
    <>
      <DocRenameDialog
        open={renameOpen}
        currentTitle={doc.title}
        onClose={() => setRenameOpen(false)}
        onSubmit={(newTitle) => { if (onRename) void onRename(doc.id, newTitle); }}
        returnFocusRef={menuTriggerRef}
      />
    <div style={style}>
      <div {...dropTargetProps} className="group relative">
        {(zone === 'before' || (zone === 'after' && !afterLineAtSubtreeEnd)) && (
          <DropLine edge={zone === 'before' ? 'top' : 'bottom'} indent={textIndent} />
        )}
        {preview && <DocPreviewCard title={preview.title} snippet={preview.snippet} x={previewPos.x} y={previewPos.y} />}
        {/* Drag handle — listeners isolated here to avoid blocking click.
            story #4345(PO 08:45Z) — 마우스 전용 조작이다: 센서가 터치를 받지 않고(#1988 터치 스크롤 하이재킹 방지 · useTouchSafePointerSensor)
            키보드 센서도 없다. 그래서 호버로만 보이게 두고(터치에 늘 보이면 안 끌리는 손잡이 · 펼침 화살표를 가림),
            dnd-kit 속성이 주는 tabIndex 0 · «스페이스로 집기» 안내는 걷는다 — 초점이 가도 할 일이 0인 투명 칸이었다.
            키보드로 순서 바꾸기는 «⋮» 메뉴의 위로 · 아래로 · 폴더로 이동(#4348). 가드 EXEMPT: hover-reveal.guard.test.ts. */}
        <div
          {...attributes}
          {...listeners}
          tabIndex={-1}
          aria-hidden="true"
          data-drag-handle="mouse-only"
          className="absolute top-1/2 z-10 -translate-y-1/2 cursor-grab touch-none opacity-0 transition group-hover:opacity-100"
          style={{ left: `${Math.min(depth * 14 + 4, 68)}px` }}
        >
          <GripVertical className="size-3 text-muted-foreground" />
        </div>
        <button
          data-doc-id={doc.id}
          onClick={handleClick}
          aria-current={isSelected ? 'page' : undefined}
          onContextMenu={handleContextMenu}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className={cn(
            // story #4345 — «⋮» 누르는 자리 24px(right-2 + 24 = 32)만큼 오른쪽 여백 → 행 글자와 겹침 0.
            'flex w-full items-center gap-2 rounded-lg pl-3 pr-8 py-2 text-left text-xs transition-all',
            isSelected
              ? 'bg-primary/10 text-primary'
              : 'text-foreground/88 hover:bg-muted hover:text-foreground',
            // story #4366 — «안으로» = 옅은 칠 + 안쪽 테두리(칠만으론 약함 · 둘째 축) · 삽입선은 안 그림.
            zone === 'into' && 'bg-primary/10 ring-1 ring-inset ring-primary',
          )}
          data-drop-zone={zone ?? undefined}
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
          <StatusDot status={doc.status} />
          <span className="flex-1 truncate font-semibold">
            {doc.title}
          </span>
        </button>
        <div
          ref={menuTriggerRef}
          role="button"
          tabIndex={0}
          // 까디르 · 유나(4724) — 아이콘뿐이라 이름 없는 메뉴 버튼이었다 → 그 행 문서 제목을 끼운 이름(행마다 같은 소리 방지 · 빈 제목 = «제목 없음»).
          aria-label={t('treeRowMenuAriaLabel', { title: doc.title?.trim() || t('newDocDefaultTitle') })}
          {...menuTriggerProps}
          onClick={(e) => {
            e.stopPropagation();
            openMenu();
          }}
          // 기본 동작을 막는다(#4724 실 키 판): 막지 않으면 Chromium이 Enter의 활성화(keypress → click)를 **이미 첫 항목으로 옮겨 간 초점**에 보내
          // 메뉴가 열리자마자 «이름 변경»이 눌렸다(jsdom은 keypress를 안 만들어 단위 시험이 못 봄).
          // story #4355 — 열린 채 초점이 «⋮»에 남아도 Esc로 닫힘(공용 훅) · Enter/Space는 열기(4348 — 고르개 닫힌 메뉴로).
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openMenu(); return; } handleMenuTriggerKeyDown(e); }}
          className={cn('absolute right-2 top-1/2 -translate-y-1/2 rounded-sm transition', HOVER_REVEAL_HIT, HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING)}
        >
          <MoreVertical className="size-3.5 text-muted-foreground" />
        </div>
        {contextMenuOpen && (
          <AnchoredPopover
            anchorRef={rowRef}
            popoverRef={menuRef}
            align="end"
            gap={4}
            {...menuPopoverProps}
            aria-labelledby={pickerOpen ? pickerTitleId : undefined}
            data-dropdown-panel="doc-tree-menu"
            onKeyDown={handleMenuKeyDown}
            className="z-50 w-48 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-1"
          >
            {pickerOpen && moveState ? (
              <>
                <p id={pickerTitleId} className="px-3 pb-1 pt-1.5 text-[11px] font-semibold text-muted-foreground">{t('docTreeMovePickerTitle')}</p>
                {/* 유나 #4730(확정 01:43Z) — 트리와 같은 깊이 우선 순서 + 깊이만큼 들여쓰기(12 + 깊이×12px · 맨 위 단계 = 0 · 맨 위 폴더 = 1).
                    지금 있는 자리는 누를 수 없는 줄(aria-disabled · aria-current="location")로 남겨 트리 모양을 지키고, 줄 끝에 «현재 위치»(aria-hidden — aria-current가 이미 읽음).
                    긴 이름은 truncate + title. 열면 첫 누를 수 있는 줄에 초점 · ↑↓는 꺼진 줄에도 닿는다. */}
                {moveState.targets.map((target) => (
                  <Button key={target.id ?? '__top'} type="button" variant="ghost" role="menuitem" data-move-target={target.id ?? ''} data-depth={target.depth} title={moveTargetTitles.get(target.id)}
                    aria-disabled={target.current || undefined} aria-current={target.current ? 'location' : undefined}
                    onClick={() => runMove({ kind: 'into', parentId: target.id }, !target.current)}
                    style={{ paddingLeft: `${12 + target.depth * 12}px` }}
                    className={DOC_MENU_ITEM}>
                    <span className="min-w-0 flex-1 truncate">{moveTargetTitles.get(target.id)}</span>
                    {target.current ? <span aria-hidden="true" data-current-location="" className="shrink-0 text-[11px] text-muted-foreground">{t('docTreeMoveCurrentLocation')}</span> : null}
                  </Button>
                ))}
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" role="menuitem" onClick={handleRename} className={DOC_MENU_ITEM}>{t('docTreeRename')}</Button>
                {moveState ? (
                  <>
                    <Button type="button" variant="ghost" role="menuitem" data-move="up" aria-disabled={!moveState.up || undefined} aria-describedby={moveState.filterLocked ? filterNoteId : moveState.sortLocked ? sortNoteId : undefined} onClick={() => runMove({ kind: 'up' }, moveState.up)} className={DOC_MENU_ITEM}>{t('docTreeMoveUp')}</Button>
                    <Button type="button" variant="ghost" role="menuitem" data-move="down" aria-disabled={!moveState.down || undefined} aria-describedby={moveState.filterLocked ? filterNoteId : moveState.sortLocked ? sortNoteId : moveState.downUnloaded ? unloadedNoteId : undefined} onClick={() => runMove({ kind: 'down' }, moveState.down)} className={DOC_MENU_ITEM}>{t('docTreeMoveDown')}</Button>
                    {/* 유나 4766(비차단) — 태그 필터 중엔 «폴더로 이동…»도 사라지지 않고 위/아래처럼 꺼진 채 같은 까닭 줄(메뉴 모양이 안 바뀜).
                        필터가 아니면 예전대로: 옮길 폴더가 지금 자리뿐이면 항목 없음. */}
                    {(moveState.filterLocked || moveState.targets.some((x) => !x.current)) && (
                      <Button type="button" variant="ghost" role="menuitem" data-move="into" aria-disabled={moveState.filterLocked || undefined} aria-describedby={moveState.filterLocked ? filterNoteId : undefined} onClick={() => { if (!moveState.filterLocked) setPickerOpen(true); }} className={DOC_MENU_ITEM}>{t('docTreeMoveInto')}</Button>
                    )}
                  </>
                ) : null}
                {isFolder && <Button type="button" variant="ghost" role="menuitem" onClick={handleAddChild} className={DOC_MENU_ITEM}>{t('docTreeAddChild')}</Button>}
                {isFolder && <Button type="button" variant="ghost" role="menuitem" onClick={handleAddChildFolder} className={DOC_MENU_ITEM}>{t('docTreeAddChildFolder')}</Button>}
                <Button type="button" variant="ghost" role="menuitem" onClick={handleDelete} className={DOC_MENU_ITEM_DESTRUCTIVE}>{t('docTreeDelete')}</Button>
                {/* 까닭 줄은 하나만 — 태그 필터 까닭 · 정렬 까닭 · «더 보기로 더 불러오면» 순(유나 확정 · story #4376 태그 필터 추가). */}
                {moveState?.filterLocked ? (
                  <p id={filterNoteId} className="mt-1 break-keep border-t border-border px-3 pb-1 pt-1.5 text-[11px] text-muted-foreground">{t('moveTagFilterActive')}</p>
                ) : moveState?.sortLocked ? (
                  <p id={sortNoteId} className="mt-1 break-keep border-t border-border px-3 pb-1 pt-1.5 text-[11px] text-muted-foreground">{t('moveSortModeActiveError')}</p>
                ) : moveState?.downUnloaded ? (
                  <p id={unloadedNoteId} className="mt-1 break-keep border-t border-border px-3 pb-1 pt-1.5 text-[11px] text-muted-foreground">{t('docTreeMoveDownUnloaded')}</p>
                ) : null}
              </>
            )}
          </AnchoredPopover>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('docTreeDeleteTitle')}
        description={t.rich('docTreeDeleteBody', {
          title: doc.title,
          // story #4120 — 조사를 문자열에 고정하지 않고 렌더 시점에 결정적으로 고른다.
          josa: pickEulReulJosa(doc.title),
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
                  dropTarget={dropTarget}
                />
              ))}
            </SortableContext>
          ) : (
            <p
              className="py-1 text-[11px] italic text-muted-foreground"
              style={{ paddingLeft: `${Math.min((depth + 1) * 14 + 24, 88)}px` }}
            >
              {/* story #4390 — 예전엔 기본값 'No child docs'(영어)를 호출부가 안 넘겨 한국어 화면에도 영어가 나왔다 → 로케일 문장(docs.noChildDocs). */}
              {emptyFolderLabel ?? t('noChildDocs')}
            </p>
          )}
        </>
      )}
      {afterLineAtSubtreeEnd && (
        <div className="relative h-0">
          <DropLine edge="bottom" indent={textIndent} />
        </div>
      )}
    </div>
    </>
  );
}

interface DropTarget {
  overId: string;
  zone: DropZone;
}

/** 앞/뒤 삽입선 — 2px · 왼쪽 끝은 그 행 글자 들여쓰기(어느 단계에 들어가는지) · 오른쪽 행 끝까지 · 끝 둥글게. */
function DropLine({ edge, indent }: { edge: 'top' | 'bottom'; indent: number }) {
  return (
    <div
      aria-hidden="true"
      data-drop-line={edge}
      className={cn('pointer-events-none absolute right-0 z-20 h-0.5 rounded-full bg-primary', edge === 'top' ? '-top-px' : '-bottom-px')}
      style={{ left: `${indent}px` }}
    />
  );
}

/** 끌리는 복제를 한 행 간격(36px = 행 32 + 간격 4) 아래로 — 그림만(판정은 포인터라 무관 · 유나 4752). */
const shiftCopyOneRowDown: Modifier = ({ transform }) => ({ ...transform, y: transform.y + 36 });
const DRAG_COPY_MODIFIERS = [shiftCopyOneRowDown];

/**
 * story #4366(유나 4752) — 겨눈 행 = **포인터가 있는 행**(가로는 트리 폭 전체라 세로만 본다). 행 사이 틈(space-y-1 · 4px)이면 가장 가까운 행.
 * dnd-kit 기본(closestCenter 등)은 끄는 사각형 = 그린 복제로 재서, 복제 위치가 바뀌면 겨눈 행도 바뀐다 — 포인터는 그림과 무관하다.
 */
export const pointerRowCollision: CollisionDetection = ({ droppableContainers, droppableRects, pointerCoordinates }) => {
  if (!pointerCoordinates) return [];
  const y = pointerCoordinates.y;
  let best: { id: string | number; distance: number; container: (typeof droppableContainers)[number] } | null = null;
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (!best || distance < best.distance) best = { id: container.id, distance, container };
  }
  return best ? [{ id: best.id, data: { droppableContainer: best.container, value: best.distance } }] : [];
};

export function DocTree({ docs: rawDocs, selectedSlug, onSelect, onReorder, onMove, onMoveDenied, onRename, onDelete, onAddChild, onAddChildFolder, emptyFolderLabel, projectId, sortMode = 'manual', onMenuMove, hasMore = false, filtered = false }: DocTreeProps) {
  const tDocs = useTranslations('docs');
  // story #4376 — 부모가 이 목록에 없는 문서(부모가 지워짐 · 태그 필터로 부모가 빠짐)도 뿌리에 보인다(예전엔 아무 데도 안 그려져 사라졌다).
  // 유나 4766 반려: 그리기만 뿌리이고 끌어 놓기 · «⋮» 계획은 숨은 부모 기준이었다 → 실효 부모 한 규칙(withEffectiveParents)으로 만든 목록 하나를
  // 그리기 · 끌기 계획 · 메뉴 상태 · 옮기기 알림이 같이 쓴다(호출부 onMenuMove 계획도 같은 함수 · docs-client-layout.tsx).
  const docs = useMemo(() => withEffectiveParents(rawDocs), [rawDocs]);
  const rootDocs = docs.filter((entry) => !entry.parent_id).sort((a, b) => compareDocsForSort(a, b, sortMode));
  // story #2167: 이름순/수정일순 보기에서는 드래그 재정렬을 막는다 — sort_order 기반 드롭
  // 위치 계산이 화면 순서와 안 맞아 엉뚱한 곳에 꽂히는 것을 막기 위함(수동 순서 자체는
  // 안전하게 보존되지만, 사용자가 보는 순서와 실제 재정렬 결과가 어긋나는 혼란을 원천 차단).
  // story #4376 — 태그 필터가 켜진 동안(걸러 낸 부분 보기)도 끈다(PO 확정): 보이는 형제만으로 순서를 저장하면 안 보이는 형제 사이로 들어간다.
  const dragEnabled = sortMode === 'manual' && !filtered;
  // story #1988(C): 순수 PointerSensor는 모바일 터치 스크롤을 드래그로 하이재킹한다 —
  // kanban-board.tsx 0d142311 fix와 동일하게 터치는 드래그 활성화 자체를 배제.
  const sensors = useTouchSafePointerSensor(5);
  const { isExpanded, toggleExpanded, expandFolders } = useTreeExpanded(projectId);

  // story #4348 — «⋮» 옮기기: 저장은 호출부(onMenuMove) · 여기선 옮긴 뒤 알림(aria-live) + 초점을 옮긴 행으로(닫힌 폴더로 옮겼으면 그 폴더와 조상을 펼침).
  // 초점은 트리가 새 자리를 그린 뒤라서, 기다리는 id를 ref에 두고 매 렌더 뒤 effect가 그 행을 찾으면 옮긴다.
  // 저장이 끝나고도(settled) 그 행이 없으면 놓는다 — 나중에 폴더를 펼칠 때 초점이 뜬금없이 끌려가지 않게.
  const navRef = useRef<HTMLElement>(null);
  const pendingFocusRef = useRef<{ id: string; settled: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [, setFocusTick] = useState(0);
  const docsRef = useRef(docs);
  useEffect(() => { docsRef.current = docs; });
  const requestMove = useCallback((docId: string, action: DocMoveAction) => {
    if (!onMenuMove) return;
    const before = docsRef.current;
    pendingFocusRef.current = { id: docId, settled: false };
    if (action.kind === 'into') {
      const chain: string[] = [];
      for (let id = action.parentId; id && !chain.includes(id); id = before.find((d) => d.id === id)?.parent_id ?? null) chain.push(id);
      expandFolders(chain);
    }
    void onMenuMove(docId, action).then((res) => {
      // 실패면 트리를 다시 읽어 그 행이 다시 그려졌을 수 있다 — 초점이 떨어졌을(body) 때만 그 행으로 되찾는다(사용자가 옮긴 초점은 안 뺏음).
      const lost = !document.activeElement || document.activeElement === document.body;
      pendingFocusRef.current = lost ? { id: docId, settled: true } : null;
      setFocusTick((n) => n + 1);
      if (!res || !res.plan.ok) return;
      const a = docMoveAnnouncement(before, res.plan, res.placed);
      const values = 'folder' in a.values ? { ...a.values, folder: a.values.folder || tDocs('newDocDefaultTitle') } : a.values;
      setAnnouncement(tDocs(DOC_MOVE_ANNOUNCE_KEY[a.kind], { ...values, title: values.title || tDocs('newDocDefaultTitle') }));
    });
  }, [onMenuMove, expandFolders, tDocs]);
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const row = Array.from(navRef.current?.querySelectorAll<HTMLElement>('button[data-doc-id]') ?? []).find((el) => el.dataset.docId === pending.id);
    if (row) row.focus();
    if (row || pending.settled) pendingFocusRef.current = null;
  });
  const moveCtxValue = onMenuMove ? { requestMove, hasMore, filtered } : null;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // 까디르(4752) — 자동 스크롤이 도는 중에 놓으면, 놓는 순간 다시 판정할 때 over.rect는 그 순간의 스크롤인데 화면의 표시는 직전 렌더 것이라
  // 표시와 저장이 갈렸다(30회 중 2회). 놓을 때는 다시 판정하지 않고 **마지막으로 그린 표시**를 그대로 쓴다 — 표시 = 결과. 표시가 없었으면 무동작.
  // useLayoutEffect — DOM이 바뀌는 그 커밋 안에서 ref도 바뀐다. useEffect(그린 뒤)면 그 사이 놓을 때 한 걸음 전 표시로 저장했다(실 브라우저 30회 중 2회).
  const drawnTargetRef = useRef<DropTarget | null>(null);
  useLayoutEffect(() => { drawnTargetRef.current = dropTarget; }, [dropTarget]);

  // story #4366 — 끄는 동안의 표시와 떨군 뒤의 결과가 같은 판정에서 나온다(dropZoneFor → planDrop).
  // 판정 상자 = over.rect = 끌 대상으로 등록된 **행**(TreeNode dropTargetProps). 순환 · 자기 자신이면 표시 없음.
  // 유나(4752 실 브라우저) — 판정은 **포인터**로만 한다. 예전엔 끄는 사각형(active.rect.current.translated)의 가운데를 썼는데, DragOverlay가
  // 있으면 dnd-kit이 그 사각형을 **그린 복제**에서 잰다(core.esm.js:2948 · 오버레이 칸의 한 자식까지 재는 getMeasurableNode :2413) —
  // 복제를 한 행 아래로 그리자 판정도 한 행 밀렸다. 겨눈 행 · 행 안 구역 둘 다 충돌 함수가 받은 pointerCoordinates 하나로 정한다.
  // 「끌기 시작 좌표 + delta」는 안 쓴다 — dnd-kit의 delta는 끌기 시작 뒤 스크롤 이동량까지 더한 값(core.esm.js:2983)인데 over.rect는
  // 스크롤을 뺀 지금의 화면 좌표(Rect 게터 :970)라, aside가 자동 스크롤되면 그만큼 구역이 밀렸다. pointerCoordinates는 시작 + 이동(:2977)으로 over.rect와 같은 화면 좌표.
  const pointerRef = useRef<Coordinates | null>(null);
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    pointerRef.current = args.pointerCoordinates;
    return pointerRowCollision(args);
  }, []);
  const resolveDrop = useCallback((event: DragMoveEvent | DragOverEvent | DragEndEvent): { target: DropTarget; plan: DocMovePlan } | null => {
    const { active, over } = event;
    if (!over || active.id === over.id) return null;
    const overDoc = docs.find((d) => d.id === over.id);
    if (!overDoc) return null;
    const pointer = pointerRef.current;
    if (!pointer) return null;
    const pointerY = pointer.y;
    const overRect = over.rect;
    const relativeY = overRect.height > 0 ? (pointerY - overRect.top) / overRect.height : 0.5;
    const isFolderRow = Boolean(overDoc.is_folder || docs.some((d) => d.parent_id === overDoc.id));
    const zone = dropZoneFor(relativeY, isFolderRow);
    const plan = planDrop(docs, String(active.id), overDoc.id, zone);
    return plan ? { target: { overId: overDoc.id, zone }, plan } : null;
  }, [docs]);

  // 까디르 · codex(4752) — 놓은 뒤 드롭 표시가 남았다(100회 중 4 · 다음 끌기 전까지). dnd-kit이 onDragMove/onDragOver를 렌더 뒤 effect에서
  // 부르는데(core.esm.js 3210 · 3244), pointerup에서 동기로 clearDrag한 **뒤에** 그 앞 렌더의 effect가 돌아 표시와 ref를 다시 채웠다.
  // 끄는 중인지는 state(activeId)가 아니라 ref로 본다 — 늦게 도는 effect가 옛 클로저를 들고 있어도 지금 값을 읽는다.
  const draggingRef = useRef(false);
  const handleDragStart = useCallback((event: DragStartEvent) => {
    draggingRef.current = true;
    pointerRef.current = null;
    drawnTargetRef.current = null;
    setDropTarget(null);
    setActiveId(String(event.active.id));
  }, []);

  // dnd-kit은 포인터가 움직이면 onDragMove를, 겨눈 행이 바뀌면 onDragOver를 따로 부른다 — onDragMove만 들으면 행이 바뀐 직후 표시가
  // 한 걸음 늦어(실 브라우저: 폴더 아래 가장자리에서 «다음 행 앞»을 보이고 떨굼은 «폴더 뒤») 표시와 결과가 갈렸다. 둘 다 같은 판정.
  const handleDragMove = useCallback((event: DragMoveEvent | DragOverEvent) => {
    if (!dragEnabled || !draggingRef.current) return;
    const next = resolveDrop(event)?.target ?? null;
    setDropTarget((prev) => (prev?.overId === next?.overId && prev?.zone === next?.zone ? prev : next));
  }, [dragEnabled, resolveDrop]);

  const clearDrag = useCallback(() => {
    draggingRef.current = false;
    drawnTargetRef.current = null;
    setActiveId(null);
    setDropTarget(null);
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const target = drawnTargetRef.current;
    clearDrag();
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!dragEnabled) { onMoveDenied?.(filtered ? 'tag-filter-active' : 'sort-mode-active'); return; }

    const activeDoc = docs.find((d) => d.id === active.id);
    if (!activeDoc) return;
    const plan = target ? planDrop(docs, activeDoc.id, target.overId, target.zone) : null;
    if (!target || !plan) {
      // 표시가 없던 자리(자기 하위 = 순환 포함) — 무동작 + 순환이면 기존 알림.
      if (isDescendant(docs, activeDoc.id, String(over.id))) onMoveDenied?.('circular');
      return;
    }
    // story #4353 — 서버(`POST /api/v2/docs/reorder`)가 형제 번호를 한 번에 다시 매긴다. 같은 부모 안 = onReorder · 부모가 바뀜 = onMove.
    const handler = plan.parentId === activeDoc.parent_id ? onReorder : onMove;
    if (!handler) {
      if (plan.parentId !== activeDoc.parent_id) onMoveDenied?.('no-permission');
      return;
    }
    const saved = await handler(plan);
    // 접힌 폴더 «안으로» 떨구면 그 폴더를 펼친다 — 옮긴 문서가 폴더 끝에 보이게(예전엔 접힌 채라 트리에서 그냥 사라졌다).
    // 저장이 실패하면(문서는 제자리) 펼치지 않는다 — 까디르(4752).
    if (saved && target.zone === 'into' && !isExpanded(target.overId)) expandFolders([target.overId]);
  }, [docs, onReorder, onMove, onMoveDenied, dragEnabled, filtered, clearDrag, isExpanded, expandFolders]);

  const activeDoc = activeId ? docs.find((d) => d.id === activeId) ?? null : null;

  return (
    <DocMoveCtx.Provider value={moveCtxValue}>
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragOver={handleDragMove} onDragEnd={handleDragEnd} onDragCancel={clearDrag}>
      <SortableContext items={rootDocs.map((d) => d.id)} strategy={verticalListSortingStrategy}>
        <div data-doc-move-live="" aria-live="polite" role="status" className="sr-only">{announcement}</div>
        <nav ref={navRef} className="space-y-1">
          {rootDocs.map((doc) => (
            <TreeNode key={doc.id} doc={doc} allDocs={docs} selectedSlug={selectedSlug} onSelect={onSelect} onReorder={onReorder} onRename={onRename} onDelete={onDelete} onAddChild={onAddChild} onAddChildFolder={onAddChildFolder} depth={0} emptyFolderLabel={emptyFolderLabel} projectId={projectId} isExpanded={isExpanded} onToggleExpanded={toggleExpanded} sortMode={sortMode} dropTarget={dropTarget} />
          ))}
        </nav>
      </SortableContext>
      {/* 포인터를 따라가는 복제 — 행 모양 그대로(행 호버와 같은 칠 · 테두리 없음 — 끄는 행 자체는 제자리에서 흐리게).
          유나(4752) — 복제가 겨눈 행 위에 그려져 «안으로» 때 폴더 이름 · 칠을 가렸다 → 한 행 간격(36px = 행 32 + 간격 4) 아래로 그린다.
          판정은 포인터로만 하니(resolveDrop · pointerRowCollision) 복제를 어디 그려도 겨눈 행 · 구역은 그대로다. 안쪽 칸만 옮기면 dnd-kit이
          그리는 바깥 칸(투명)이 겨눈 행을 여전히 덮어(elementFromPoint = 오버레이 칸) 오버레이 전체를 옮기고, 누름도 통과시킨다. */}
      <DragOverlay dropAnimation={null} modifiers={DRAG_COPY_MODIFIERS} className="pointer-events-none">
        {activeDoc ? (
          <div data-drag-copy className="flex items-center gap-2 rounded-lg bg-muted py-2 pl-3 pr-8 text-xs text-foreground">
            {activeDoc.icon ? <span className="shrink-0 text-sm">{activeDoc.icon}</span> : activeDoc.is_folder ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
            <span className="flex-1 truncate font-semibold">{activeDoc.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
    </DocMoveCtx.Provider>
  );
}
