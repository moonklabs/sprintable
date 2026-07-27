'use client';

import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface UpgradeModalProps {
  message: string;
  onClose: () => void;
}

export function UpgradeModal({ message, onClose }: UpgradeModalProps) {
  const t = useTranslations('common');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <div className="text-center">
          <div className="mb-3 text-4xl">🚀</div>
          <DialogTitle className="text-lg font-semibold text-foreground">{t('upgradeRequired')}</DialogTitle>
          <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        </div>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t('cancel')}
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- story a539c649 S2 오탐, invite-accept-client.tsx 주석 참고 */}
          <a
            href="/dashboard/settings"
            className="flex-1 rounded-lg bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('upgradePlan')}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
