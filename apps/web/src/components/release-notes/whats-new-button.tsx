'use client';

import { Sparkles } from 'lucide-react';
import { useReleaseNotes } from './release-notes-gate';

/** top-bar What's-new 버튼. provider 밖(컨텍스트 null)이면 렌더 안 함. */
export function WhatsNewButton() {
  const ctx = useReleaseNotes();
  if (!ctx) return null;

  return (
    <button
      type="button"
      onClick={ctx.open}
      aria-label="What's new"
      className="relative flex size-8 items-center justify-center rounded-md text-foreground/70 transition hover:bg-accent hover:text-foreground"
    >
      <Sparkles className="size-4" />
      {ctx.hasUnseen && (
        <span
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-info ring-2 ring-background"
          aria-hidden
        />
      )}
    </button>
  );
}
