'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';

/** story #4752 — the confirmation of «계정 삭제». Before, it closed without a word on every failure except `REAUTHENTICATION_REQUIRED` (an `alert`): a person who pressed «삭제 확인» and got a 403
 *  or a 500 saw the dialog vanish and could not tell whether the account was gone. Now every end says something, and the dialog stays open on a failure so the person can try again:
 *  - ok → the account is closed at once (the server signs the person out of everything and refuses a new sign-in): to the login page;
 *  - 404 → there is no such live account any more (already deleted): the same way out, to the login page;
 *  - `REAUTHENTICATION_REQUIRED` → «다시 로그인한 뒤 삭제해 주세요»;
 *  - 401 → the session is over: «로그인이 끝났어요 …»;
 *  - anything else, or the network → «삭제하지 못했어요 …» (nothing was deleted: the server answers ok only after it closed the account). */
export function DeleteAccountDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/account/delete', { method: 'POST' });
      if (res.ok || res.status === 404) { onDeleted(); return; }
      const json = await res.json().catch(() => null) as { error?: { code?: string } } | null;
      if (json?.error?.code === 'REAUTHENTICATION_REQUIRED') setError(t('reauthRequired'));
      else if (res.status === 401) setError(t('deleteSessionEnded'));
      else setError(t('deleteFailed'));
    } catch {
      setError(t('deleteFailed'));
    }
    setDeleting(false);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !deleting) onClose(); }}>
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogTitle className="text-lg font-semibold text-destructive">{t('deleteConfirmTitle')}</DialogTitle>
        <p className="mt-2 text-sm text-muted-foreground">{t('deleteConfirmDesc')}</p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive" data-testid="delete-account-error">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex gap-3">
          <Button variant="glass" className="flex-1" onClick={onClose} disabled={deleting}>
            {tc('cancel')}
          </Button>
          <Button variant="destructive" className="flex-1" onClick={() => void confirm()} disabled={deleting} data-testid="delete-account-confirm">
            {deleting ? '...' : t('confirmDelete')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
