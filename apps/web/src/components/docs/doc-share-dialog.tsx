'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Info, Copy, Check } from 'lucide-react';

interface ShareLabels {
  share: string;
  shareToWeb: string;
  shareToWebDesc: string;
  copyLink: string;
  linkCopied: string;
  stopSharing: string;
  regenerateLink: string;
  shareSingleDocNote: string;
}

interface DocShareDialogProps {
  open: boolean;
  onClose: () => void;
  docId: string;
  labels: ShareLabels;
}

/**
 * Public share manager (b1574f5a). Opt-in (default OFF). Enabling mints an opaque
 * token → public `/share/<token>` link; regenerate kills the old token; stop
 * revokes. The form lives in an inner component so it remounts (fresh fetch) each
 * open — the Base UI Popup unmounts its children when closed.
 */
export function DocShareDialog({ open, onClose, docId, labels }: DocShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{labels.share}</DialogTitle>
        </DialogHeader>
        <DocShareForm docId={docId} labels={labels} />
      </DialogContent>
    </Dialog>
  );
}

function DocShareForm({ docId, labels }: { docId: string; labels: ShareLabels }) {
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = loading
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/docs/${docId}/share`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        const d = j?.data as { enabled?: boolean; token?: string | null } | undefined;
        setEnabled(d?.enabled ?? false);
        setToken(d?.token ?? null);
      })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, [docId]);

  const shareUrl = token ? `${typeof window !== 'undefined' ? window.location.origin : ''}/share/${token}` : '';

  const enable = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/docs/${docId}/share`, { method: 'POST' });
      if (r.ok) {
        const { data } = await r.json() as { data: { token?: string | null } };
        setEnabled(true);
        setToken(data?.token ?? null);
      }
    } catch { /* leave state unchanged on failure */ } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/docs/${docId}/share`, { method: 'DELETE' });
      if (r.ok) { setEnabled(false); setToken(null); }
    } catch { /* leave state unchanged on failure */ } finally { setBusy(false); }
  };

  const regenerate = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/docs/${docId}/share/regenerate`, { method: 'POST' });
      if (r.ok) {
        const { data } = await r.json() as { data: { token?: string | null } };
        setToken(data?.token ?? null);
      }
    } catch { /* leave state unchanged on failure */ } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard?.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  const isOn = enabled === true;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">{labels.shareToWeb}</p>
          <p className="text-xs text-muted-foreground">{labels.shareToWebDesc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label={labels.shareToWeb}
          disabled={busy || enabled === null}
          onClick={() => { if (busy || enabled === null) return; void (isOn ? disable() : enable()); }}
          className={`relative inline-flex h-[22px] w-[38px] flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${isOn ? 'bg-success' : 'bg-muted-foreground/30'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-background shadow-sm transition-transform ${isOn ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
        </button>
      </div>

      {isOn && token && (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs text-foreground outline-none"
            />
            <Button size="sm" variant="outline" onClick={() => void copy()} className="flex-shrink-0">
              {copied ? <Check className="mr-1 size-3.5 text-success" /> : <Copy className="mr-1 size-3.5" />}
              {copied ? labels.linkCopied : labels.copyLink}
            </Button>
          </div>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Info className="size-3 shrink-0" />
            {labels.shareSingleDocNote}
          </p>
          <div className="flex items-center justify-between pt-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void regenerate()}>
              {labels.regenerateLink}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disable()} className="text-destructive focus:text-destructive">
              {labels.stopSharing}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
