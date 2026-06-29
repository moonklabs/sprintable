'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import React, { type RefObject } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { CustomImageNode } from './extensions/image-node';
import { ImageUploadExtension, registerDocIdProvider } from './extensions/image-upload';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, Strikethrough, Code, Link2, Highlighter, Undo2, Redo2, PanelLeft, Plus, ImageIcon, Paperclip } from 'lucide-react';
import { pickAndUpload } from './extensions/slash-command';
import { CalloutNode } from './extensions/callout-node';
import { SlashCommandExtension } from './extensions/slash-command';
import { PageEmbedExtension } from './extensions/page-embed-node';
import { CodeBlockWithCopy } from './extensions/code-block-copy';
import { ToggleBlock, ToggleSummary, ToggleContent } from './extensions/toggle-block';
import { FileAttachmentNode } from './extensions/file-node';
import { EmbedBlock } from './extensions/embed-node';
import { MathBlockNode, MathInlineNode } from './extensions/math-node';
import { ColumnsBlock, ColumnBlock } from './extensions/column-layout';
import { WikiLinkNode, createWikiLinkSuggestion } from './extensions/wiki-link';
import { DocToc } from './doc-toc';
import { type DocHeading, slugifyHeading } from './doc-heading-utils';
import { markdownToHtml, htmlToMarkdown } from './lib/content-converter';
import { MobileSelectionMenu, isMobileDevice } from './mobile-selection-menu';
import { useTranslations } from 'next-intl';

type ContentFormat = 'markdown' | 'html';
type ViewMode = 'preview' | 'markdown';

export function DocEditor({
  value,
  contentFormat,
  editable = true,
  currentDocId,
  onNavigate,
  onFileError,
  projectId,
  onChange,
  onSave,
  isDirty = false,
  autosave = true,
  onAutosaveToggle,
  title,
  onTitleChange,
  titlePlaceholder,
  titleAutoFocus,
  breadcrumb,
  urlSlot,
  actions,
  metaSlot,
  dispatchSlot,
  onOpenTree,
  syncBanner,
  labels,
}: {
  value: string;
  contentFormat: ContentFormat;
  editable?: boolean;
  currentDocId?: string;
  onNavigate?: (slug: string) => void;
  onFileError?: (message: string) => void;
  projectId?: string;
  onChange: (value: string) => void;
  onContentFormatChange?: (format: ContentFormat) => void;
  onSave?: () => Promise<boolean>;
  isDirty?: boolean;
  autosave?: boolean;
  onAutosaveToggle?: (enabled: boolean) => void;
  title?: string;
  onTitleChange?: (value: string) => void;
  titlePlaceholder?: string;
  titleAutoFocus?: boolean;
  breadcrumb?: React.ReactNode;
  /** Inline URL chip slot, rendered under the title (above the tab bar). */
  urlSlot?: React.ReactNode;
  actions?: React.ReactNode;
  /** §3-2 단일 슬림 헤더: 제목 아래 muted 메타 서브라인(수정 이력 N · 시각). 배지는 DocGateSection SSOT. */
  metaSlot?: React.ReactNode;
  /** 박스1: 담당자 아바타+popover(헤더 액션 클러스터·glanceable owner). */
  dispatchSlot?: React.ReactNode;
  /** 박스1: 모바일 트리 드로어 열기(헤더 좌측 트리 아이콘·lg:hidden·칩 띠 대체). */
  onOpenTree?: () => void;
  /** Sync-state off-ramp banner (conflict / remote-changed), rendered below the toolbar. */
  syncBanner?: React.ReactNode;
  labels: {
    contentFormat: string;
    markdown: string;
    preview: string;
    save: string;
    toolbar: string;
    placeholder: string;
    h1: string;
    h2: string;
    bold: string;
    italic: string;
    bullet: string;
    quote: string;
    code: string;
    link: string;
    autosave: string;
    undo: string;
    redo: string;
  };
}) {
  const tEditor = useTranslations('docs');
  const suppressUpdateRef = useRef(false);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [tocHeadings, setTocHeadings] = useState<DocHeading[]>([]);
  const [isFocused, setIsFocused] = useState(false);
  const editorContentRef = useRef<HTMLDivElement>(null);
  // S4 첨부 진입: gutter "+" 위치 / 빈 문서 힌트 / DnD active-zone.
  const [gutterTop, setGutterTop] = useState<number | null>(null);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (!onFileError) return;
    const handleFileSizeError = (e: Event) => {
      const msg = (e as CustomEvent<{ message: string }>).detail.message;
      onFileError(msg);
    };
    window.addEventListener('docs:file-size-error', handleFileSizeError);
    return () => window.removeEventListener('docs:file-size-error', handleFileSizeError);
  }, [onFileError]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockWithCopy,
      Link.configure({ openOnClick: false }),
      CustomImageNode,
      ImageUploadExtension,
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Placeholder.configure({
        placeholder: labels.placeholder,
        showOnlyCurrent: false,
        includeChildren: true,
      }),
      CalloutNode,
      ToggleBlock,
      ToggleSummary,
      ToggleContent,
      FileAttachmentNode,
      EmbedBlock,
      MathBlockNode,
      MathInlineNode,
      ColumnsBlock,
      ColumnBlock,
      WikiLinkNode.configure({
        projectId,
        onNavigate,
        suggestion: createWikiLinkSuggestion(projectId),
      }),
      SlashCommandExtension,
      PageEmbedExtension.configure({ currentDocId, onNavigate }),
    ],
    editable,
    content: contentFormat === 'markdown' ? markdownToHtml(value) : value,
    onUpdate: ({ editor: e }) => {
      if (suppressUpdateRef.current) return;
      const html = e.getHTML();
      if (contentFormat === 'markdown') {
        onChange(htmlToMarkdown(html));
      } else {
        onChange(html);
      }
    },
    onFocus: () => setIsFocused(true),
    onBlur: () => setIsFocused(false),
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // 업로드 확장이 라이브로 읽는 docId 등록(doc 전환 대응·storage mutate / ref 전달 회피).
  useEffect(() => {
    if (!editor) return;
    return registerDocIdProvider(editor, () => currentDocId);
  }, [editor, currentDocId]);

  // gutter "+" 위치(현재 캐럿 줄) + 빈 문서 여부 추적.
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      setIsEmpty(editor.isEmpty);
      const wrap = editorContentRef.current;
      if (!wrap) return;
      try {
        const { from } = editor.state.selection;
        const coords = editor.view.coordsAtPos(from);
        const rect = wrap.getBoundingClientRect();
        setGutterTop(coords.top - rect.top + wrap.scrollTop);
      } catch {
        setGutterTop(null);
      }
    };
    sync();
    editor.on('selectionUpdate', sync);
    editor.on('update', sync);
    editor.on('focus', sync);
    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('update', sync);
      editor.off('focus', sync);
    };
  }, [editor]);

  // 메뉴 바깥 클릭 시 닫기.
  useEffect(() => {
    if (!insertMenuOpen) return;
    const close = () => setInsertMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [insertMenuOpen]);

  const openImagePicker = useCallback(() => {
    if (editor) pickAndUpload(editor, 'image/*');
    setInsertMenuOpen(false);
  }, [editor]);
  const openFilePicker = useCallback(() => {
    if (editor) pickAndUpload(editor);
    setInsertMenuOpen(false);
  }, [editor]);

  // DnD active-zone — 파일 드래그 동안 점선 오버레이(실 drop 은 ProseMirror handleDrop 처리).
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);
  const onDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);
  const onDrop = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragging(false);
  }, []);

  // Extract TOC headings from editor + assign IDs to heading DOM elements
  useEffect(() => {
    if (!editor) return;

    const update = () => {
      const counts = new Map<string, number>();
      const headings: DocHeading[] = [];

      editor.state.doc.descendants((node) => {
        if (node.type.name === 'heading') {
          const text = node.textContent.trim();
          if (!text) return true;
          const baseId = slugifyHeading(text);
          const seen = counts.get(baseId) ?? 0;
          counts.set(baseId, seen + 1);
          headings.push({
            level: node.attrs.level as 1 | 2 | 3,
            text,
            id: seen === 0 ? baseId : `${baseId}-${seen + 1}`,
          });
        }
        return true;
      });

      setTocHeadings(headings);

      // Assign IDs to heading DOM elements
      const root = editorContentRef.current;
      if (!root) return;
      const idCounts = new Map<string, number>();
      root.querySelectorAll<HTMLElement>('h1, h2, h3').forEach((el) => {
        const baseId = slugifyHeading(el.textContent ?? '');
        const seen2 = idCounts.get(baseId) ?? 0;
        idCounts.set(baseId, seen2 + 1);
        el.id = seen2 === 0 ? baseId : `${baseId}-${seen2 + 1}`;
      });
    };

    update();
    editor.on('update', update);
    return () => { editor.off('update', update); };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const currentHtml = editor.getHTML();
    const incomingHtml = contentFormat === 'markdown' ? markdownToHtml(value) : value;

    if (currentHtml === incomingHtml) return;

    const currentOutput = contentFormat === 'markdown' ? htmlToMarkdown(currentHtml) : currentHtml;
    if (currentOutput === value) return;

    suppressUpdateRef.current = true;
    editor.commands.setContent(incomingHtml, { emitUpdate: false });
    suppressUpdateRef.current = false;
  }, [editor, value, contentFormat]);

  const rawMarkdown = contentFormat === 'markdown' ? value : htmlToMarkdown(value);

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const md = e.target.value;
      if (contentFormat === 'markdown') {
        onChange(md);
      } else {
        onChange(markdownToHtml(md));
      }
    },
    [contentFormat, onChange],
  );

  const scrollToHeading = useCallback((id: string) => {
    const root = editorContentRef.current;
    const el = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const addLink = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('URL:');
    if (url) editor.chain().focus().setLink({ href: url }).run();
  }, [editor]);

  // addImage/insertTable: 데스크 영구 툴바 제거로 dead code화 — 이미지/표는 slash command(/)으로 도달(기능 보존).

  const titleRef = useRef<HTMLTextAreaElement>(null);

  const autoResizeTitle = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (titleRef.current) autoResizeTitle(titleRef.current);
  }, [title, autoResizeTitle]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card max-md:h-[100dvh]">
      {/* 수직 밀도 재설계: 12+ 밴드 → 슬림 sticky 헤더 1줄 통합(breadcrumb·제목·메타·url·탭·TOC·액션·
          자동저장·저장). 영구 툴바·별도 저장바·중복 헤더 밴드 제거(기능 위치만 이동·제거 0). content dominant(~74%).
          포맷=BubbleMenu(선택)·slash(/)·단축키·모바일 하단 툴바로 도달. */}
      <header className="sticky top-0 z-10 flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-card px-3 py-1.5">
        {/* 박스1: 모바일 트리 아이콘(칩 띠 대체·lg:hidden·드로어 트리거·데스크는 사이드바 트리) */}
        {onOpenTree ? (
          <button
            type="button"
            onClick={onOpenTree}
            aria-label="문서 트리 열기"
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
          >
            <PanelLeft className="size-4" />
          </button>
        ) : null}
        {breadcrumb ? <div className="hidden shrink-0 items-center lg:flex">{breadcrumb}</div> : null}
        {title !== undefined ? (
          /* 인라인 제목 1줄(editable textarea·whitespace-nowrap·flex-1 min-w-0·편집 기능 보존) */
          <textarea
            ref={titleRef}
            value={title}
            onChange={(e) => {
              onTitleChange?.(e.target.value);
              autoResizeTitle(e.target);
            }}
            placeholder={titlePlaceholder ?? 'Untitled'}
            autoFocus={titleAutoFocus}
            rows={1}
            className="min-w-[7rem] flex-1 resize-none overflow-hidden whitespace-nowrap bg-transparent text-lg font-bold leading-snug outline-none placeholder:text-muted-foreground/40"
          />
        ) : null}
        {metaSlot ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline-flex">{metaSlot}</span> : null}
        {urlSlot ? <div className="hidden shrink-0 lg:block">{urlSlot}</div> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* compact 탭 세그먼트 */}
          <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
            {(['preview', 'markdown'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                  viewMode === mode
                    ? 'bg-card text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {mode === 'preview' ? labels.preview : labels.markdown}
              </button>
            ))}
          </div>
          {/* TOC — ≥3 headings */}
          <DocToc headings={tocHeadings} onHeadingClick={scrollToHeading} />
          {/* 자동저장 토글(별도 저장바서 헤더로 이동·라벨=title 속성·compact) */}
          {onAutosaveToggle ? (
            <button
              type="button"
              role="switch"
              aria-checked={autosave}
              onClick={() => onAutosaveToggle(!autosave)}
              title={labels.autosave}
              aria-label={labels.autosave}
              className="flex shrink-0 items-center"
            >
              <span
                className={`relative inline-flex h-[18px] w-[30px] flex-shrink-0 items-center rounded-full transition-colors ${
                  autosave ? 'bg-success' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-background shadow-sm transition-transform ${
                    autosave ? 'translate-x-[14px]' : 'translate-x-[3px]'
                  }`}
                />
              </span>
            </button>
          ) : null}
          {/* 저장 버튼(별도 저장바서 헤더로 이동) */}
          {onSave ? (
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={!isDirty}
              className="shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {labels.save}
            </button>
          ) : null}
          {/* 박스1: 담당자 아바타+popover(glanceable owner·Dispatch 밴드 대체) */}
          {dispatchSlot}
          {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
        </div>
      </header>

      {/* Sync off-ramp banner (conflict / remote-changed) — below the toolbar, above content */}
      {syncBanner ? <div className="px-3 pt-2">{syncBanner}</div> : null}

      {/* Floating bubble toolbar — visible on text selection in preview mode */}
      {editor && editable && viewMode === 'preview' && (
        <>
        <BubbleMenu
          editor={editor}
          shouldShow={() => !isMobileDevice()}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-background p-1"
        >
          <BubbleButton
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="굵게 (Ctrl+B)"
          >
            <Bold className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="기울임 (Ctrl+I)"
          >
            <Italic className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="취소선"
          >
            <Strikethrough className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            active={editor.isActive('code')}
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="인라인 코드"
          >
            <Code className="size-3.5" />
          </BubbleButton>
          <span className="mx-0.5 h-4 w-px bg-border/60" />
          <BubbleButton
            active={editor.isActive('link')}
            onClick={() => {
              if (editor.isActive('link')) {
                editor.chain().focus().unsetLink().run();
              } else {
                const url = window.prompt('URL:');
                if (url) editor.chain().focus().setLink({ href: url }).run();
              }
            }}
            title="링크"
          >
            <Link2 className="size-3.5" />
          </BubbleButton>
          <BubbleButton
            active={editor.isActive('highlight')}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
            title="형광펜"
          >
            <Highlighter className="size-3.5" />
          </BubbleButton>
        </BubbleMenu>
        <MobileSelectionMenu editor={editor} />
        </>
      )}

      {/* Editor content — fills remaining height */}
      {viewMode === 'markdown' ? (
        <textarea
          value={rawMarkdown}
          onChange={handleTextareaChange}
          readOnly={!editable}
          className="flex-1 w-full resize-none bg-transparent p-4 font-mono text-sm leading-relaxed outline-none"
          placeholder={labels.placeholder}
        />
      ) : (
        <div
          ref={editorContentRef as RefObject<HTMLDivElement>}
          onDragEnter={onDragEnter}
          onDragOver={(e) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault(); }}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className="tiptap-editor-wrapper relative flex-1 overflow-y-auto p-3 pl-9 max-md:pb-20 max-md:min-h-[50vh]"
        >
          <EditorContent editor={editor} className="tiptap-content h-full outline-none" />

          {/* 빈 문서 힌트 — 첨부 진입 discoverability(+ · / · DnD). */}
          {editable && isEmpty ? (
            <p className="pointer-events-none absolute left-9 top-3 select-none text-sm text-muted-foreground/50">
              {tEditor('attachEmptyHint')}
            </p>
          ) : null}

          {/* gutter "+" — 현재 줄 좌측 거터·항상 표시·클릭 시 이미지/파일 삽입 메뉴 */}
          {editable && gutterTop !== null ? (
            <div
              contentEditable={false}
              className="absolute left-1.5 z-20"
              style={{ top: gutterTop }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <button
                type="button"
                aria-label={tEditor('attachInsertMenu')}
                aria-haspopup="menu"
                aria-expanded={insertMenuOpen}
                onClick={(e) => { e.stopPropagation(); setInsertMenuOpen((v) => !v); }}
                className="flex size-6 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
              {insertMenuOpen ? (
                <div
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-7 top-0 w-36 overflow-hidden rounded-lg border border-border bg-card p-1 shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openImagePicker}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <ImageIcon className="size-4 text-muted-foreground" />
                    {tEditor('attachImage')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={openFilePicker}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <Paperclip className="size-4 text-muted-foreground" />
                    {tEditor('attachFile')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* DnD active-zone 오버레이 — 파일 드래그 중(목업 .dnd.active). pointer-events-none 로 실 drop 통과. */}
          {editable && isDragging ? (
            <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-info bg-info/10 text-center">
              <span className="flex size-9 items-center justify-center rounded-full bg-info/10 text-info">
                <Plus className="size-4" />
              </span>
              <span className="text-sm font-semibold text-foreground">{tEditor('attachDropTitle')}</span>
              <span className="text-xs text-muted-foreground">{tEditor('attachDropHint')}</span>
            </div>
          ) : null}
        </div>
      )}

      {/* 수직 밀도 재설계: 별도 저장 바 제거 → 자동저장 토글·저장 버튼·저장 상태(InlineSaveIndicator)는
          슬림 헤더로 이동(기능 보존·content height 회복). */}

      {/* Mobile sticky bottom toolbar — appears on editor focus in preview mode */}
      {editor && editable && viewMode === 'preview' && (
        <div
          role="toolbar"
          aria-label={labels.toolbar}
          className={`fixed bottom-0 left-0 right-0 z-30 border-t border-border/60 bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm transition-transform duration-200 md:hidden ${
            isFocused ? 'translate-y-0' : 'translate-y-full pointer-events-none'
          }`}
        >
          <div className="flex overflow-x-auto items-center gap-1 px-2 py-2" onMouseDown={(e) => e.preventDefault()}>
            <ToolbarButton
              active={false}
              disabled={!editor.can().undo()}
              ariaLabel={labels.undo}
              onClick={() => editor.chain().focus().undo().run()}
            >
              <Undo2 className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton
              active={false}
              disabled={!editor.can().redo()}
              ariaLabel={labels.redo}
              onClick={() => editor.chain().focus().redo().run()}
            >
              <Redo2 className="size-3.5" />
            </ToolbarButton>
            <Sep />
            <ToolbarButton
              active={editor.isActive('heading', { level: 1 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            >
              {labels.h1}
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('heading', { level: 2 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              {labels.h2}
            </ToolbarButton>
            <Sep />
            <ToolbarButton
              active={editor.isActive('bold')}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              {labels.bold}
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('italic')}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              {labels.italic}
            </ToolbarButton>
            <Sep />
            <ToolbarButton
              active={editor.isActive('bulletList')}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              {labels.bullet}
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('blockquote')}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            >
              {labels.quote}
            </ToolbarButton>
            <ToolbarButton
              active={editor.isActive('codeBlock')}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            >
              {labels.code}
            </ToolbarButton>
            <Sep />
            <ToolbarButton active={false} onClick={addLink}>
              {labels.link}
            </ToolbarButton>
          </div>
        </div>
      )}
    </div>
  );
}

function BubbleButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-md p-1.5 transition-colors ${
        active
          ? 'bg-primary/14 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarButton({
  active,
  onClick,
  disabled,
  ariaLabel,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
        disabled
          ? 'cursor-not-allowed border-border/40 bg-card text-muted-foreground opacity-50'
          : active
            ? 'border-primary/50 bg-primary/14 text-primary'
            : 'border-border/60 bg-card text-foreground hover:border-primary/50 hover:text-primary'
      }`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-5 w-px bg-border/60" />;
}
