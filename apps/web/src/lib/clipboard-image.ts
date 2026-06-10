import type { ClipboardEvent } from 'react';

/**
 * Extract image files from a paste event's clipboard (E-MOBILE-UX S3).
 * Returns the image File objects so the caller can reuse its existing upload path;
 * non-image clipboard content (text, etc.) yields an empty array so normal paste proceeds.
 */
export function imageFilesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
