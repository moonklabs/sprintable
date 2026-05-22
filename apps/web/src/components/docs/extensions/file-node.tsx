'use client';

import { useCallback } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { FileIcon, DownloadIcon } from 'lucide-react';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader 오류'));
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.readAsDataURL(file);
  });
}

// ─── File Attachment View ─────────────────────────────────────────────────────

function FileAttachmentView({ node }: ReactNodeViewProps) {
  const filename = node.attrs.filename as string;
  const size = node.attrs.size as number;
  const data = node.attrs.data as string;

  const handleDownload = useCallback(() => {
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [data, filename]);

  return (
    <NodeViewWrapper as="div" className="my-3 not-prose">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand/10 text-[color:var(--brand-soft)]">
          <FileIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{filename}</p>
          <p className="text-xs text-muted-foreground">{formatFileSize(size)}</p>
        </div>
        <button
          type="button"
          contentEditable={false}
          onClick={handleDownload}
          className="flex-shrink-0 rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:border-brand/40 hover:text-[color:var(--brand-soft)]"
          aria-label="파일 다운로드"
        >
          <DownloadIcon className="size-4" />
        </button>
      </div>
    </NodeViewWrapper>
  );
}

// ─── Node Definition ──────────────────────────────────────────────────────────

export const FileAttachmentNode = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      filename: { default: '' },
      size: { default: 0 },
      mimeType: { default: '' },
      data: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="fileAttachment"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { filename, size, mimeType, data } = HTMLAttributes as Record<string, unknown>;
    return [
      'div',
      mergeAttributes({
        'data-type': 'fileAttachment',
        'data-filename': filename,
        'data-size': String(size),
        'data-mime-type': mimeType,
        'data-file-data': data,
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentView);
  },
});
