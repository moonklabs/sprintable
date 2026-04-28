'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Placeholder from '@tiptap/extension-placeholder';
import { CalloutNode } from './extensions/callout-node';
import { SlashCommandExtension } from './extensions/slash-command';
import { PageEmbedExtension } from './extensions/page-embed-node';
import { CodeBlockWithCopy } from './extensions/code-block-copy';
import { markdownToHtml, htmlToMarkdown } from './lib/content-converter';

type ContentFormat = 'markdown' | 'html';
type ViewMode = 'preview' | 'markdown';

export function DocEditor({
  value,
  contentFormat,
  editable = true,
  currentDocId,
  onNavigate,
  onChange,
  onContentFormatChange,
  onSave,
  isDirty = false,
  autosave = true,
  onAutosaveToggle,
  labels,
}: {
  value: string;
  contentFormat: ContentFormat;
  editable?: boolean;
  currentDocId?: string;
  onNavigate?: (slug: string) => void;
  onChange: (value: string) => void;
  onContentFormatChange?: (format: ContentFormat) => void;
  onSave?: () => Promise<boolean>;
  isDirty?: boolean;
  autosave?: boolean;
  onAutosaveToggle?: (enabled: boolean) => void;
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

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockWithCopy,
      Link.configure({ openOnClick: false }),
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Placeholder.configure({ placeholder: labels.placeholder }),
      CalloutNode,
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

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-background">
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
