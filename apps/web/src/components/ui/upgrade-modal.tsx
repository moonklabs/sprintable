'use client';

import { useTranslations } from 'next-intl';

interface UpgradeModalProps {
  message: string;
  onClose: () => void;
}

export function UpgradeModal({ message, onClose }: UpgradeModalProps) {
  const t = useTranslations('common');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="text-center">
          <div className="mb-3 text-4xl">🚀</div>
          <h3 className="text-lg font-semibold text-gray-900">{t('upgradeRequired')}</h3>
          <p className="mt-2 text-sm text-gray-500">{message}</p>
        </div>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {t('cancel')}
          </button>
          <a
            href="/dashboard/settings"
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
          >
            {t('upgradePlan')}
          </a>
        </div>
      </div>
    </div>
  );
}
