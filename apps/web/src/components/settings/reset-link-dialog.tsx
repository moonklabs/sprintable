'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ds/dialog';
import { Input } from '@/components/ds/input';
import { copyTextSafely } from '@/lib/clipboard';

export interface ResetLinkDialogProps {
  open: boolean;
  member: { name: string; email?: string };
  url: string;
  minutes: number;
  onClose: () => void;
}

/**
 * story 5023 (d) — the link an OWNER of a workspace server hands to a member who forgot their password (the server has no mail). It is a secret for its few minutes: whoever opens it sets the person's password. The person is told so,
 * and that THEY choose the new password (the owner never sees one). Copy → the clipboard; when the browser refuses, the link is selectable in the field (the same way the invitation link is).
 */
export function ResetLinkDialog({ open, member, url, minutes, onClose }: ResetLinkDialogProps) {
  const ts = useTranslations('settings');
  const tc = useTranslations('common');
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async () => {
    const result = await copyTextSafely(url);
    setCopied(result.ok);
    setCopyFailed(!result.ok);
    if (result.ok) setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" initialFocus={closeRef} aria-labelledby={titleId} data-testid="reset-link-dialog">
        <DialogHeader>
          <DialogTitle id={titleId}>{ts('orgMemberResetLinkTitle')}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-ds-ink">{member.name}</span>
            {member.email ? <span className="text-ds-ink-3"> ({member.email})</span> : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-ds-body text-ds-ink">{ts('orgMemberResetLinkBody', { name: member.name, minutes })}</p>
          <div className="flex items-center gap-2">
            <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono" data-testid="reset-link-url" aria-label={ts('orgMemberResetLinkTitle')} />
            <Button variant="secondary" onClick={() => void copy()} data-testid="reset-link-copy">
              {copied ? <Check className="size-ds-icon-md" aria-hidden="true" /> : <Copy className="size-ds-icon-md" aria-hidden="true" />}
              <span className="ml-1">{copied ? ts('orgMemberResetLinkCopied') : ts('orgMemberResetLinkCopy')}</span>
            </Button>
          </div>
          {copyFailed ? <Banner tone="failed">{tc('copyFailedSelectManually')}</Banner> : null}
          <p className="text-ds-small text-ds-ink-3">{ts('orgMemberResetLinkNote')}</p>
        </div>
        <DialogFooter>
          <Button ref={closeRef} variant="quiet" onClick={onClose}>{tc('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
