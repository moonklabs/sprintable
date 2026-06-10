'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';
import { slugifyDocTitle, isUntitledSlug } from './lib/doc-slug';

/** Result of an explicit slug submission — drives the dialog's inline feedback. */
export type SlugSubmitResult =
  | { ok: true }
  | { ok: false; code: 'taken'; suggestion?: string }
  | { ok: false; code: 'invalid' };

interface DialogLabels {
  editUrl: string;
  urlDialogDesc: string;
  deriveFromTitle: string;
  aliasNote: string;
  slugTaken: string;
  slugInvalid: string;
  save: string;
  cancel: string;
}

interface DocUrlDialogProps {
  open: boolean;
  onClose: () => void;
  currentSlug: string;
  /** Doc title — backs the "generate from title" shortcut. */
  title: string;
  onSubmit: (slug: string) => Promise<SlugSubmitResult>;
  labels: DialogLabels;
}

/**
 * Explicit slug editor (AC2). Manual edits lock the slug (slug_locked: true) so
 * auto-derivation stops. Surfaces BE conflicts (409 → suggested `-N`) and format
 * errors (422) inline. The slug is shown/edited decoded — Korean stays readable.
 *
 * The form lives in an inner component so it remounts (fresh state) each time the
 * dialog opens — the Base UI Popup unmounts its children when closed.
 */
export function DocUrlDialog({ open, onClose, currentSlug, title, onSubmit, labels }: DocUrlDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{labels.editUrl}</DialogTitle>
          <DialogDescription>{labels.urlDialogDesc}</DialogDescription>
        </DialogHeader>
        <DocUrlDialogForm
          currentSlug={currentSlug}
          title={title}
          onSubmit={onSubmit}
          onClose={onClose}
          labels={labels}
        />
      </DialogContent>
    </Dialog>
  );
}

function DocUrlDialogForm({
  currentSlug,
  title,
  onSubmit,
  onClose,
  labels,
}: {
  currentSlug: string;
  title: string;
  onSubmit: (slug: string) => Promise<SlugSubmitResult>;
  onClose: () => void;
  labels: DialogLabels;
}) {
  const [value, setValue] = useState(() => (isUntitledSlug(currentSlug) ? '' : currentSlug));
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const showDerive = isUntitledSlug(currentSlug) || value.trim() === '';
  // Only docs that already have a real (non-untitled) slug can have inbound links
  // worth preserving — skip the alias note for brand-new docs (nit 3).
  const hasExistingSlug = !isUntitledSlug(currentSlug);

  const handleSubmit = async () => {
    const slug = slugifyDocTitle(value);
    if (!slug || submitting) return;
    setSubmitting(true);
    setSuggestion(null);
    setInvalid(false);
    const result = await onSubmit(slug);
    setSubmitting(false);
    if (result.ok) {
      onClose();
    } else if (result.code === 'taken') {
      setSuggestion(result.suggestion ?? null);
    } else {
      setInvalid(true);
    }
  };

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-sm text-muted-foreground">/docs/</span>
          <Input
            value={value}
            onChange={(e) => { setValue(e.target.value); setSuggestion(null); setInvalid(false); }}
            onBlur={() => setValue((v) => slugifyDocTitle(v))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSubmit(); } }}
            autoFocus
            aria-label={labels.editUrl}
            className="font-mono"
          />
        </div>

        {showDerive && (
          <button
            type="button"
            onClick={() => { setValue(slugifyDocTitle(title)); setSuggestion(null); setInvalid(false); }}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            ↳ {labels.deriveFromTitle}
          </button>
        )}

        {suggestion ? (
          <p className="text-xs text-warning">
            {labels.slugTaken} →{' '}
            <button
              type="button"
              onClick={() => { setValue(suggestion); setSuggestion(null); }}
              className="font-mono font-medium underline underline-offset-2"
            >
              {suggestion}
            </button>
          </p>
        ) : invalid ? (
          <p className="text-xs text-destructive">{labels.slugInvalid}</p>
        ) : hasExistingSlug ? (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Info className="size-3 shrink-0" />
            {labels.aliasNote}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>{labels.cancel}</Button>
        <Button onClick={() => void handleSubmit()} disabled={submitting || slugifyDocTitle(value) === ''}>
          {labels.save}
        </Button>
      </DialogFooter>
    </>
  );
}
