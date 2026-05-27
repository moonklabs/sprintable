'use client';

import { useTranslations } from 'next-intl';

interface UpgradeModalProps {
  message: string;
  onClose: () => void;
}

export function UpgradeModal({ message, onClose }: UpgradeModalProps) {
  const t = useTranslations('common');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-backdrop">
      <div className="w-full max-w-[calc(100%-2rem)] rounded-2xl bg-background p-6 shadow-xl sm:max-w-sm">
        <div className="text-center">
          <div className="mb-3 text-4xl">🚀</div>
          <h3 className="text-lg font-semibold text-foreground">{t('upgradeRequired')}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        </div>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t('cancel')}
          </button>
          <a
            href="/dashboard/settings"
            className="flex-1 rounded-lg bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('upgradePlan')}
          </a>
        </div>
      </div>
    </div>
  );
}
