'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import React from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { CustomImageNode } from './extensions/image-node';
import { ImageUploadExtension } from './extensions/image-upload';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, Strikethrough, Code, Link2, Highlighter } from 'lucide-react';
import { CalloutNode } from './extensions/callout-node';
import { SlashCommandExtension } from './extensions/slash-command';
import { PageEmbedExtension } from './extensions/page-embed-node';
import { CodeBlockWithCopy } from './extensions/code-block-copy';
import { ToggleBlock, ToggleSummary, ToggleContent } from './extensions/toggle-block';
import { FileAttachmentNode } from './extensions/file-node';
import { EmbedBlock } from './extensions/embed-node';
import { MathBlockNode, MathInlineNode } from './extensions/math-node';
import { markdownToHtml, htmlToMarkdown } from './lib/content-converter';

type ContentFormat = 'markdown' | 'html';
type ViewMode = 'preview' | 'markdown';

export function DocEditor({
  value,
  contentFormat,
  editable = true,
  currentDocId,
  onNavigate,
  onFileError,
  onChange,
  onSave,
  isDirty = false,
  autosave = true,
  onAutosaveToggle,
  title,
  onTitleChange,
  titlePlaceholder,
  titleAutoFocus,
  actions,
  labels,
}: {
  value: string;
  contentFormat: ContentFormat;
  editable?: boolean;
  currentDocId?: string;
  onNavigate?: (slug: string) => void;
  onFileError?: (message: string) => void;
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
  actions?: React.ReactNode;
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
  };
}) {
  const suppressUpdateRef = useRef(false);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');

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
      Placeholder.configure({ placeholder: labels.placeholder }),
      CalloutNode,
      ToggleBlock,
      ToggleSummary,
      ToggleContent,
      FileAttachmentNode,
      EmbedBlock,
      MathBlockNode,
      MathInlineNode,
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
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

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

  const addLink = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('URL:');
    if (url) editor.chain().focus().setLink({ href: url }).run();
  }, [editor]);

  const addImage = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('Image URL:');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  }, [editor]);

  const insertTable = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }, [editor]);

  const titleRef = useRef<HTMLTextAreaElement>(null);

  const autoResizeTitle = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (titleRef.current) autoResizeTitle(titleRef.current);
  }, [title, autoResizeTitle]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-background">
      {/* Inline title (Notion style) */}
      {title !== undefined && (
        <div className="flex flex-shrink-0 items-start justify-between gap-2 px-6 pb-2 pt-8">
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
            className="w-full resize-none overflow-hidden bg-transparent text-4xl font-bold leading-tight outline-none placeholder:text-muted-foreground/40"
          />
          {actions && (
            <div className="flex flex-shrink-0 items-center gap-1 pt-1">
              {actions}
            </div>
          )}
        </div>
      )}

      {/* Tab bar + toolbar */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        {/* View mode tabs */}
        <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
          {(['preview', 'markdown'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                viewMode === mode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {mode === 'preview' ? labels.preview : labels.markdown}
            </button>
          ))}
        </div>

        {/* Toolbar — only in preview mode */}
        {viewMode === 'preview' && editor ? (
          <div className="flex flex-wrap items-center gap-1.5">
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
            <ToolbarButton active={false} onClick={addImage}>
              🖼
            </ToolbarButton>
            <ToolbarButton active={false} onClick={insertTable}>
              ⊞
            </ToolbarButton>
          </div>
        ) : null}
      </div>

      {/* Floating bubble toolbar — visible on text selection in preview mode */}
      {editor && editable && viewMode === 'preview' && (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-background p-1 shadow-lg"
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
        <div className="tiptap-editor-wrapper flex-1 overflow-y-auto p-3">
          <EditorContent editor={editor} className="tiptap-content h-full outline-none" />
        </div>
      )}

      {/* Save bar — always visible when onSave is provided */}
      {onSave ? (
        <div className="flex flex-shrink-0 items-center justify-between border-t border-border/60 bg-muted/20 px-4 py-2.5">
          {/* Autosave switch */}
          {onAutosaveToggle ? (
            <button
              type="button"
              role="switch"
              aria-checked={autosave}
              onClick={() => onAutosaveToggle(!autosave)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{labels.autosave}</span>
              <span
                className={`relative inline-flex h-[18px] w-[30px] flex-shrink-0 items-center rounded-full transition-colors ${
                  autosave ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
                    autosave ? 'translate-x-[14px]' : 'translate-x-[3px]'
                  }`}
                />
              </span>
            </button>
          ) : <span />}
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!isDirty}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {labels.save}
          </button>
        </div>
      ) : null}
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
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
        active
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
