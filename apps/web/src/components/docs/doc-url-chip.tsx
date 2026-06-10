'use client';

import { Pencil, AlertTriangle } from 'lucide-react';
import { isUntitledSlug } from './lib/doc-slug';

interface DocUrlChipProps {
  slug: string;
  /** Opens the URL-edit dialog. When omitted, the chip is display-only. */
  onEdit?: () => void;
  /** Derives a slug from the current title. Shown as a nudge while the slug is still `untitled-*`. */
  onDeriveFromTitle?: () => void;
  labels: {
    editUrl: string;
    slugNudge: string;
  };
}

/**
 * Inline URL chip rendered under the doc title — surfaces the document's address
 * (`/docs/<slug>`) where it was previously invisible. Low-intensity by design so
 * the title stays the focal point. While a new doc still carries its
 * `untitled-<timestamp>` slug, it nudges the user to derive a real URL.
 */
export function DocUrlChip({ slug, onEdit, onDeriveFromTitle, labels }: DocUrlChipProps) {
  if (isUntitledSlug(slug) && onDeriveFromTitle) {
    return (
      <button
        type="button"
        onClick={onDeriveFromTitle}
        className="inline-flex items-center gap-1.5 text-xs text-warning transition-colors hover:text-warning/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning/40 rounded"
      >
        <span className="max-w-[60vw] truncate font-mono md:max-w-md">/docs/{slug}</span>
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className="size-3" />
          {labels.slugNudge}
        </span>
      </button>
    );
  }

  return (
    <div className="group inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="max-w-[60vw] truncate font-mono md:max-w-md">/docs/{slug}</span>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={labels.editUrl}
          title={labels.editUrl}
          className="rounded opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border group-hover:opacity-100"
        >
          <Pencil className="size-3" />
        </button>
      )}
    </div>
  );
}
