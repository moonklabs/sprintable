'use client';

import { Pencil, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING, HOVER_REVEAL_HIT } from '@/lib/hover-reveal';
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
        className="inline-flex items-center gap-1.5 text-xs text-warning-strong transition-colors hover:text-warning-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning rounded"
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
          // story #4345 — 호버 없는 기기에선 늘 보인다(예전엔 초점에서만 · 터치는 늘 투명).
          // 초점 링은 규약 링(citron) — 예전 `ring-border`는 배경 대비가 거의 없어 초점이 사실상 안 보였다(까디르 P3 · 유나).
          // 누르는 자리 24×24(연필 그대로) · 줄 높이 무변(-my-1).
          className={cn('-my-1 rounded transition-opacity hover:text-foreground', HOVER_REVEAL_HIT, HOVER_REVEAL, HOVER_REVEAL_FOCUS_RING)}
        >
          <Pencil className="size-3" />
        </button>
      )}
    </div>
  );
}
