'use client';

import { useEffect, useCallback, useRef } from 'react';
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
  labels,
}: {
  value: string;
  contentFormat: ContentFormat;
  editable?: boolean;
  /** ID of the currently open document — prevents self-embed in page-embed blocks. */
  currentDocId?: string;
  /** Called when user clicks an embedded page link. */
  onNavigate?: (slug: string) => void;
  onChange: (value: string) => void;
  onContentFormatChange: (format: ContentFormat) => void;
  onSave?: () => Promise<boolean>;
  isDirty?: boolean;
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
  };
}) {
  const suppressUpdateRef = useRef(false);

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

  // Sync editable prop changes
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // Sync external value changes into the editor
  useEffect(() => {
    if (!editor) return;
    const currentHtml = editor.getHTML();
    const incomingHtml = contentFormat === 'markdown' ? markdownToHtml(value) : value;

    // Avoid re-setting if content matches (prevents cursor jump)
    if (currentHtml === incomingHtml) return;

    const currentOutput = contentFormat === 'markdown' ? htmlToMarkdown(currentHtml) : currentHtml;
    if (currentOutput === value) return;

    suppressUpdateRef.current = true;
    editor.commands.setContent(incomingHtml, { emitUpdate: false });
    suppressUpdateRef.current = false;
  }, [editor, value, contentFormat]);

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
    <div className="flex flex-col gap-0 overflow-hidden rounded-2xl border border-border/60 bg-background">
      {editor ? (
        <>
          {/* Tab bar + toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
            {/* Format tabs */}
            <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
              {(['html', 'markdown'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => onContentFormatChange(format)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${contentFormat === format ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {format === 'html' ? labels.preview : labels.markdown}
                </button>
              ))}
            </div>

            {/* Toolbar */}
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
          </div>

          {/* Editor content */}
          <div className="tiptap-editor-wrapper p-3">
            <EditorContent editor={editor} className="tiptap-content min-h-[420px] outline-none" />
          </div>

          {/* Dirty save bar */}
          {isDirty && onSave ? (
            <div className="flex items-center justify-end border-t border-border/60 bg-muted/20 px-4 py-2.5">
              <button
                type="button"
                onClick={() => void onSave()}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {labels.save}
              </button>
            </div>
          ) : null}
        </>
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
