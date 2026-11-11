'use client';

// story 4891 (UI-8 · settings frame + four tabs) — the confirmation of «프로젝트 삭제», drawn with the ds Dialog. The page keeps the state (which project, whether it is deleting) and the request; this file only draws the question and hands the two presses back.
// Same words as before (`projectDeleteConfirmTitle` · `projectDeleteConfirmDesc` · «취소» · «삭제»); the window opens on «취소», the way the other irreversible confirmations of the settings do.
import { useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ds/dialog';

export function ProjectDeleteDialog({ deleting, onClose, onConfirm }: { deleting: boolean; onClose: () => void; onConfirm: () => void }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !deleting) onClose(); }}>
      <DialogContent className="max-w-sm" showCloseButton={false} initialFocus={cancelRef} aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId} className="text-ds-failed">{t('projectDeleteConfirmTitle')}</DialogTitle>
          <DialogDescription>{t('projectDeleteConfirmDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} variant="quiet" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? '...' : t('deleteProject')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
